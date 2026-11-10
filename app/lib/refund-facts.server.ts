import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  lessonProgress,
  lessons,
  modules,
  videoWatchEvents,
  LessonProgressStatus,
} from "~/db/schema";
import type { RefundEligibilityFacts } from "~/lib/refund-eligibility";

/**
 * Gathers what checkRefundEligibility needs about a learner's use of a
 * course, as of `today`. The refund action, the course page and the Admin
 * approval screen all read the facts here, so they agree on them.
 */
export function getRefundEligibilityFacts(
  db: Db,
  input: {
    userId: number;
    courseId: number;
    purchasedAt: string;
    today: Date;
  }
): RefundEligibilityFacts {
  const lessonIds = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, input.courseId))
    .all()
    .map((row) => row.id);

  return {
    purchasedAt: input.purchasedAt,
    today: input.today,
    totalLessons: lessonIds.length,
    completedLessons: countCompletedLessons(db, input.userId, lessonIds),
    secondsWatched: sumSecondsWatched(db, input.userId, lessonIds),
  };
}

function countCompletedLessons(db: Db, userId: number, lessonIds: number[]) {
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

// Watch time is the furthest point reached in each lesson, summed, so
// rewatching a lesson doesn't count twice.
function sumSecondsWatched(db: Db, userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}
