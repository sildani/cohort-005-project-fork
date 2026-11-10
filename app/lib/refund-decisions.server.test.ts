import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "~/db";
import { createTestDb } from "~/db/test-db";
import {
  categories,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
  CourseStatus,
  LessonProgressStatus,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import {
  approveRefundRequest,
  declineRefundRequest,
  findRefundRequestForPurchase,
  raiseRefundRequest,
} from "./refund-decisions.server";

// Liam bought a $79 course, watched part of the first lesson, and raised a
// Refund Request. Two Admins, Ada and Grace, can decide it.
function seedLiamsRefundRequest(db: Db) {
  const [instructor, liam, ada, grace] = db
    .insert(users)
    .values([
      { name: "Ines", email: "ines@example.com", role: UserRole.Instructor },
      { name: "Liam", email: "liam@example.com", role: UserRole.Student },
      { name: "Ada", email: "ada@example.com", role: UserRole.Admin },
      { name: "Grace", email: "grace@example.com", role: UserRole.Admin },
    ])
    .returning()
    .all();

  const category = db
    .insert(categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();

  const course = db
    .insert(courses)
    .values({
      title: "Introduction to TypeScript",
      slug: "intro-to-typescript",
      description: "Types for JavaScript.",
      salesCopy: "Learn TypeScript.",
      instructorId: instructor.id,
      categoryId: category.id,
      status: CourseStatus.Published,
      price: 7900,
    })
    .returning()
    .get();

  const module = db
    .insert(modules)
    .values({ courseId: course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  const lesson = db
    .insert(lessons)
    .values({ moduleId: module.id, title: "Hello types", position: 1 })
    .returning()
    .get();

  const purchase = db
    .insert(purchases)
    .values({ userId: liam.id, courseId: course.id, amountPaid: 7900 })
    .returning()
    .get();

  db.insert(enrollments).values({ userId: liam.id, courseId: course.id }).run();

  db.insert(lessonProgress)
    .values({
      userId: liam.id,
      lessonId: lesson.id,
      status: LessonProgressStatus.InProgress,
    })
    .run();

  db.insert(videoWatchEvents)
    .values({
      userId: liam.id,
      lessonId: lesson.id,
      eventType: "progress",
      positionSeconds: 300,
    })
    .run();

  const refundRequest = db
    .insert(refunds)
    .values({
      purchaseId: purchase.id,
      status: RefundStatus.Open,
      reason: "Bought the wrong one, I meant the advanced course.",
    })
    .returning()
    .get();

  return { liam, ada, grace, course, purchase, refundRequest };
}

let db: Db;
let liam: ReturnType<typeof seedLiamsRefundRequest>;

beforeEach(() => {
  db = createTestDb();
  liam = seedLiamsRefundRequest(db);
});

function reload(refundRequestId: number) {
  return db.select().from(refunds).where(eq(refunds.id, refundRequestId)).get();
}

describe("approveRefundRequest", () => {
  it("approves an Open Refund Request and refunds the full amount paid", () => {
    const result = approveRefundRequest(db, {
      refundRequestId: liam.refundRequest.id,
      adminUserId: liam.ada.id,
    });

    expect(result).toMatchObject({ ok: true });
    expect(reload(liam.refundRequest.id)).toMatchObject({
      status: RefundStatus.Approved,
      amountRefunded: 7900,
      resolvedByUserId: liam.ada.id,
      declineReason: null,
    });
    expect(reload(liam.refundRequest.id)?.resolvedAt).not.toBeNull();
  });

  it("removes the learner's enrollment but keeps their progress and watch history", () => {
    approveRefundRequest(db, {
      refundRequestId: liam.refundRequest.id,
      adminUserId: liam.ada.id,
    });

    const learner = liam.liam.id;
    expect(
      db.select().from(enrollments).where(eq(enrollments.userId, learner)).all()
    ).toEqual([]);
    expect(
      db.select().from(lessonProgress).where(eq(lessonProgress.userId, learner)).all()
    ).toHaveLength(1);
    expect(
      db.select().from(videoWatchEvents).where(eq(videoWatchEvents.userId, learner)).all()
    ).toHaveLength(1);
  });
});

describe("declineRefundRequest", () => {
  it("declines an Open Refund Request with the Decline Reason and leaves access alone", () => {
    const result = declineRefundRequest(db, {
      refundRequestId: liam.refundRequest.id,
      adminUserId: liam.ada.id,
      declineReason: "You bought it over a month ago.",
    });

    expect(result).toMatchObject({ ok: true });
    expect(reload(liam.refundRequest.id)).toMatchObject({
      status: RefundStatus.Declined,
      declineReason: "You bought it over a month ago.",
      amountRefunded: null,
      resolvedByUserId: liam.ada.id,
    });
    expect(
      db.select().from(enrollments).where(eq(enrollments.userId, liam.liam.id)).all()
    ).toHaveLength(1);
  });
});

describe("two Admins deciding at once", () => {
  it("keeps the first decision and tells the second Admin who already decided", () => {
    approveRefundRequest(db, {
      refundRequestId: liam.refundRequest.id,
      adminUserId: liam.ada.id,
    });

    const late = declineRefundRequest(db, {
      refundRequestId: liam.refundRequest.id,
      adminUserId: liam.grace.id,
      declineReason: "You bought it over a month ago.",
    });

    expect(late).toEqual({
      ok: false,
      alreadyDecided: { status: RefundStatus.Approved, byName: "Ada" },
    });
    expect(reload(liam.refundRequest.id)).toMatchObject({
      status: RefundStatus.Approved,
      declineReason: null,
      resolvedByUserId: liam.ada.id,
    });
  });

  it("doesn't refund or remove access when an approval comes after a decline", () => {
    declineRefundRequest(db, {
      refundRequestId: liam.refundRequest.id,
      adminUserId: liam.grace.id,
      declineReason: "You bought it over a month ago.",
    });

    const late = approveRefundRequest(db, {
      refundRequestId: liam.refundRequest.id,
      adminUserId: liam.ada.id,
    });

    expect(late).toEqual({
      ok: false,
      alreadyDecided: { status: RefundStatus.Declined, byName: "Grace" },
    });
    expect(reload(liam.refundRequest.id)).toMatchObject({
      status: RefundStatus.Declined,
      amountRefunded: null,
    });
    expect(
      db.select().from(enrollments).where(eq(enrollments.userId, liam.liam.id)).all()
    ).toHaveLength(1);
  });
});

describe("findRefundRequestForPurchase", () => {
  it("still finds the Refund Request after it has been declined", () => {
    declineRefundRequest(db, {
      refundRequestId: liam.refundRequest.id,
      adminUserId: liam.ada.id,
      declineReason: "You bought it over a month ago.",
    });

    expect(findRefundRequestForPurchase(db, liam.purchase.id)).toMatchObject({
      id: liam.refundRequest.id,
      status: RefundStatus.Declined,
      declineReason: "You bought it over a month ago.",
    });
  });
});

describe("raiseRefundRequest", () => {
  it("refuses a second Refund Request on the same purchase and keeps the first", () => {
    const second = raiseRefundRequest(db, {
      purchaseId: liam.purchase.id,
      reason: "Asking again in another tab, just in case.",
    });

    expect(second).toEqual({ ok: false, alreadyRequested: true });
    expect(findRefundRequestForPurchase(db, liam.purchase.id)).toMatchObject({
      id: liam.refundRequest.id,
      reason: "Bought the wrong one, I meant the advanced course.",
    });
  });
});
