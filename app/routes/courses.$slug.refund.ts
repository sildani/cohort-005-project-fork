import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses, purchases, refunds, users, RefundStatus } from "~/db/schema";
import { and, eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  checkRefundEligibility,
  REFUND_WINDOW_DAYS,
  type RefundIneligibleReason,
} from "~/lib/refund-eligibility";
import { getLatestPersonalPurchase } from "~/lib/personal-purchase.server";
import { getRefundEligibilityFacts } from "~/lib/refund-facts.server";
import { findRefundRequestForPurchase } from "~/lib/refund-decisions.server";

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
    subject: `Refund Request received — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your refund request for "${input.courseTitle}".`,
      `The refund is for ${formatPrice(input.amount)}, the amount you paid.`,
      "",
      "Someone at Cadence reviews every refund request by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— Cadence",
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

  // A purchase has at most one Refund Request, whatever the decision was.
  if (findRefundRequestForPurchase(db, purchase.id)) {
    throw data("You have already asked for a refund on this purchase.", {
      status: 409,
    });
  }

  const eligibility = checkRefundEligibility(
    getRefundEligibilityFacts(db, {
      userId: currentUserId,
      courseId: course.id,
      purchasedAt: purchase.createdAt,
      today: new Date(),
    })
  );

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
