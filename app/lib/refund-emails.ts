import { formatPrice } from "~/lib/utils";

/**
 * The emails a learner gets when an Admin decides their Refund Request. There
 * is no mail transport wired up yet, so callers log the built message.
 */

type Recipient = {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
};

export function buildRefundApprovedEmail(
  input: Recipient & { amount: number }
) {
  return {
    to: input.learnerEmail,
    subject: `Refund approved — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have approved your refund request for "${input.courseTitle}".`,
      `We are refunding ${formatPrice(input.amount)}, the full amount you paid.`,
      "",
      `You no longer have access to "${input.courseTitle}".`,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

// Shown to the Admin on the decline confirm step too, so they see the same
// words the learner will.
export const DECLINE_IS_FINAL =
  "This decision is final. This purchase can't be refunded.";

export function buildRefundDeclinedEmail(
  input: Recipient & { declineReason: string }
) {
  return {
    to: input.learnerEmail,
    subject: `Refund declined — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have declined your refund request for "${input.courseTitle}".`,
      "",
      input.declineReason,
      "",
      DECLINE_IS_FINAL,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
