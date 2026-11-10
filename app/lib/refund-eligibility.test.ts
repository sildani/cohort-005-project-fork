import { describe, it, expect } from "vitest";
import { checkRefundEligibility, daysLeftInWindow } from "./refund-eligibility";

// A learner who bought a course this morning and has barely started it. Each
// test changes one fact to probe one rule.
const freshPurchase = {
  purchasedAt: new Date(2026, 10, 2, 9, 0).toISOString(),
  today: new Date(2026, 10, 2, 12, 0),
  totalLessons: 10,
  completedLessons: 0,
  secondsWatched: 0,
};

describe("checkRefundEligibility", () => {
  it("accepts a fresh purchase and gives the last day of the 14-day window", () => {
    expect(checkRefundEligibility(freshPurchase)).toEqual({
      eligible: true,
      lastDayInWindow: "2026-11-16",
    });
  });

  describe("the 14-day window", () => {
    it("counts whole days, so a purchase at 23:00 keeps all of its fourteenth day", () => {
      expect(
        checkRefundEligibility({
          ...freshPurchase,
          purchasedAt: new Date(2026, 10, 2, 23, 0).toISOString(),
          today: new Date(2026, 10, 16, 23, 59),
        })
      ).toEqual({ eligible: true, lastDayInWindow: "2026-11-16" });
    });

    it("refuses a Refund Request on the day after the window closes", () => {
      expect(
        checkRefundEligibility({
          ...freshPurchase,
          today: new Date(2026, 10, 17, 0, 1),
        })
      ).toEqual({ eligible: false, reason: "window-closed" });
    });
  });

  describe("watch time", () => {
    it("refuses a Refund Request once two hours have been watched", () => {
      expect(
        checkRefundEligibility({ ...freshPurchase, secondsWatched: 7200 })
      ).toEqual({ eligible: false, reason: "watched-too-much" });
    });

    it("accepts a Refund Request just under two hours watched", () => {
      expect(
        checkRefundEligibility({ ...freshPurchase, secondsWatched: 7199 })
      ).toMatchObject({ eligible: true });
    });
  });

  describe("lesson completion", () => {
    it("accepts a Refund Request while under half the lessons are completed", () => {
      expect(
        checkRefundEligibility({ ...freshPurchase, completedLessons: 4 })
      ).toMatchObject({ eligible: true });
    });

    it("refuses a Refund Request once half the lessons are completed", () => {
      expect(
        checkRefundEligibility({ ...freshPurchase, completedLessons: 5 })
      ).toEqual({ eligible: false, reason: "completed-too-much" });
    });
  });
});

describe("daysLeftInWindow", () => {
  const purchasedAt = new Date(2026, 10, 2, 23, 0).toISOString();

  it("gives the full 14 days on the day of purchase", () => {
    expect(daysLeftInWindow(purchasedAt, new Date(2026, 10, 2, 23, 30))).toBe(14);
  });

  it("gives 0 on the last day of the window", () => {
    expect(daysLeftInWindow(purchasedAt, new Date(2026, 10, 16, 23, 59))).toBe(0);
  });

  it("goes negative once the window has closed", () => {
    expect(daysLeftInWindow(purchasedAt, new Date(2026, 10, 19, 0, 1))).toBe(-3);
  });
});
