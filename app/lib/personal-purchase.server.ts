import { and, eq, notExists, sql } from "drizzle-orm";
import { db } from "~/db";
import { coupons, purchases } from "~/db/schema";

/**
 * The learner's most recent Personal Purchase of a course, or undefined.
 * A Team Licence is a purchase that created Seats (coupons), so a Personal
 * Purchase is one with none.
 */
export function getLatestPersonalPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId),
        notExists(
          db
            .select({ id: coupons.id })
            .from(coupons)
            .where(eq(coupons.purchaseId, purchases.id))
        )
      )
    )
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}
