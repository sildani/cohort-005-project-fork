/**
 * The rules for whether a learner may raise a Refund Request on a purchase.
 * The course page uses them to decide whether to offer a refund, and the
 * refund action uses them to accept or reject the request. Keep both on this
 * one function so they can't drift apart.
 */

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundEligibilityFacts = {
  purchasedAt: string;
  today: Date;
  totalLessons: number;
  completedLessons: number;
  secondsWatched: number;
  hasClaimedSeat: boolean;
};

export type RefundIneligibleReason =
  | "claimed-seat"
  | "window-closed"
  | "watched-too-much"
  | "completed-too-much";

export type RefundEligibility =
  | { eligible: true; lastDayInWindow: string }
  | { eligible: false; reason: RefundIneligibleReason };

export function checkRefundEligibility(
  facts: RefundEligibilityFacts
): RefundEligibility {
  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team: the buyer cannot hand it back on their own.
  if (facts.hasClaimedSeat) {
    return { eligible: false, reason: "claimed-seat" };
  }

  const lastDay = lastDayInWindow(facts.purchasedAt);

  if (calendarDay(facts.today) > lastDay) {
    return { eligible: false, reason: "window-closed" };
  }

  if (
    facts.totalLessons > 0 &&
    facts.completedLessons / facts.totalLessons >= REFUND_COMPLETION_LIMIT
  ) {
    return { eligible: false, reason: "completed-too-much" };
  }

  if (facts.secondsWatched >= REFUND_WATCH_LIMIT_SECONDS) {
    return { eligible: false, reason: "watched-too-much" };
  }

  return { eligible: true, lastDayInWindow: lastDay };
}

// The window is counted in whole calendar days, not hours: someone who buys
// at 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayInWindow(purchasedAt: string): string {
  const deadline = new Date(purchasedAt);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}
