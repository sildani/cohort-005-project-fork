import { describe, it, expect } from "vitest";
import {
  buildRefundApprovedEmail,
  buildRefundDeclinedEmail,
} from "./refund-emails";

const liam = {
  learnerName: "Liam",
  learnerEmail: "liam@example.com",
  courseTitle: "Introduction to TypeScript",
};

describe("buildRefundApprovedEmail", () => {
  it("tells the learner the amount refunded and that their access is ending", () => {
    const email = buildRefundApprovedEmail({ ...liam, amount: 7900 });

    expect(email.to).toBe("liam@example.com");
    expect(email.subject).toBe(
      "Refund approved — Introduction to TypeScript"
    );
    expect(email.body).toContain("$79.00");
    expect(email.body).toContain(
      'You no longer have access to "Introduction to TypeScript".'
    );
  });
});

describe("buildRefundDeclinedEmail", () => {
  it("gives the Decline Reason word for word and says the decision is final", () => {
    const email = buildRefundDeclinedEmail({
      ...liam,
      declineReason: "You completed the course before asking.",
    });

    expect(email.to).toBe("liam@example.com");
    expect(email.subject).toBe(
      "Refund declined — Introduction to TypeScript"
    );
    expect(email.body).toContain("You completed the course before asking.");
    expect(email.body).toContain(
      "This decision is final. This purchase can't be refunded."
    );
  });
});
