import { and, eq } from "drizzle-orm";
import type { Db } from "~/db";
import {
  enrollments,
  purchases,
  refunds,
  users,
  RefundStatus,
} from "~/db/schema";

/**
 * An Admin's decision on a Refund Request. Decisions are final, and only an
 * Open Refund Request can be decided.
 */

type Decision = { refundRequestId: number; adminUserId: number };

type AlreadyDecided = {
  ok: false;
  alreadyDecided: { status: RefundStatus; byName: string | null };
};

// The update only matches an Open Refund Request, so when two Admins decide at
// once the first write wins and the second finds nothing to update.
function describeEarlierDecision(
  db: Pick<Db, "select">,
  refundRequestId: number
): AlreadyDecided {
  const earlier = db
    .select({ status: refunds.status, byName: users.name })
    .from(refunds)
    .leftJoin(users, eq(refunds.resolvedByUserId, users.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!earlier) {
    throw new Error(`Refund Request ${refundRequestId} not found`);
  }

  return { ok: false, alreadyDecided: earlier };
}

export function approveRefundRequest(db: Db, decision: Decision) {
  return db.transaction((tx) => {
    const request = tx
      .select({ purchase: purchases })
      .from(refunds)
      .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
      .where(eq(refunds.id, decision.refundRequestId))
      .get();

    if (!request) {
      throw new Error(`Refund Request ${decision.refundRequestId} not found`);
    }

    const approved = tx
      .update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: request.purchase.amountPaid,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: decision.adminUserId,
      })
      .where(
        and(
          eq(refunds.id, decision.refundRequestId),
          eq(refunds.status, RefundStatus.Open)
        )
      )
      .returning()
      .get();

    if (!approved) {
      return describeEarlierDecision(tx, decision.refundRequestId);
    }

    // Access comes from the enrollment. Progress and watch history stay, so a
    // learner who buys the course again picks up where they left off.
    tx.delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, request.purchase.userId),
          eq(enrollments.courseId, request.purchase.courseId)
        )
      )
      .run();

    return { ok: true as const, refundRequest: approved };
  });
}

export function declineRefundRequest(
  db: Db,
  decision: Decision & { declineReason: string }
) {
  const declined = db
    .update(refunds)
    .set({
      status: RefundStatus.Declined,
      declineReason: decision.declineReason,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: decision.adminUserId,
    })
    .where(
      and(
        eq(refunds.id, decision.refundRequestId),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .returning()
    .get();

  if (!declined) {
    return describeEarlierDecision(db, decision.refundRequestId);
  }

  return { ok: true as const, refundRequest: declined };
}

/**
 * The purchase's Refund Request, whatever its status. A purchase has at most
 * one, so a decided request still blocks a new one.
 */
export function findRefundRequestForPurchase(db: Db, purchaseId: number) {
  return db
    .select()
    .from(refunds)
    .where(eq(refunds.purchaseId, purchaseId))
    .get();
}
