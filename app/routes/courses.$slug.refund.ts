import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import {
  courses,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
} from "~/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  checkRefundEligibility,
  REFUND_WINDOW_DAYS,
  type RefundIneligibleReason,
} from "~/lib/refund-eligibility";
import { getLatestPersonalPurchase } from "~/lib/personal-purchase.server";

const INELIGIBLE_MESSAGES: Record<RefundIneligibleReason, string> = {
  "window-closed": `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
  "watched-too-much":
    "You have watched too much of this course to request a refund.",
  "completed-too-much":
    "You have completed too much of this course to request a refund.",
};

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

function hasAnyPurchase(userId: number, courseId: number) {
  const row = db
    .select({ id: purchases.id })
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .get();

  return Boolean(row);
}

function getLessonIdsForCourse(courseId: number): number[] {
  const rows = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all();

  return rows.map((row) => row.id);
}

function getOpenRefundRequest(purchaseId: number) {
  return db
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .get();
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

/**
 * The confirmation the learner gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
function buildRefundRequestEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.learnerEmail,
    subject: `Refund requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your refund request for "${input.courseTitle}".`,
      `The refund is for ${formatPrice(input.amount)}, the amount you paid.`,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const learner = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!learner) {
    throw data("User not found", { status: 404 });
  }

  const purchase = getLatestPersonalPurchase(currentUserId, course.id);

  if (!purchase) {
    if (hasAnyPurchase(currentUserId, course.id)) {
      throw data(
        "Refund Requests are for personal purchases. Team licences can't be refunded here.",
        { status: 403 }
      );
    }
    throw data("You have not bought this course.", { status: 403 });
  }

  if (getOpenRefundRequest(purchase.id)) {
    throw data("You already have an open refund request on this purchase.", {
      status: 409,
    });
  }

  const courseLessonIds = getLessonIdsForCourse(course.id);

  let watchedSeconds = 0;
  if (courseLessonIds.length > 0) {
    const furthestPerLesson = db
      .select({
        furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
      })
      .from(videoWatchEvents)
      .where(
        and(
          eq(videoWatchEvents.userId, currentUserId),
          inArray(videoWatchEvents.lessonId, courseLessonIds)
        )
      )
      .groupBy(videoWatchEvents.lessonId)
      .all();

    watchedSeconds = furthestPerLesson.reduce(
      (total, row) => total + row.furthest,
      0
    );
  }

  const eligibility = checkRefundEligibility({
    purchasedAt: purchase.createdAt,
    today: new Date(),
    totalLessons: courseLessonIds.length,
    completedLessons: getCompletedLessonCount(currentUserId, courseLessonIds),
    secondsWatched: watchedSeconds,
  });

  if (!eligibility.eligible) {
    throw data(INELIGIBLE_MESSAGES[eligibility.reason], { status: 403 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  db
    .insert(refunds)
    .values({
      purchaseId: purchase.id,
      status: RefundStatus.Open,
      reason: parsed.data.reason,
    })
    .returning()
    .get();

  const email = buildRefundRequestEmail({
    learnerName: learner.name,
    learnerEmail: learner.email,
    courseTitle: course.title,
    amount: purchase.amountPaid,
  });

  console.log(
    `[email] to=${email.to} subject=${email.subject}\n${email.body}`
  );

  return redirect("/settings");
}
