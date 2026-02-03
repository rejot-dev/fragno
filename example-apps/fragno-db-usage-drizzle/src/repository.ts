import { eq, like, desc, and, sql, aliasedTable } from "drizzle-orm";
import { getDrizzleDatabase } from "./database";
import { appUser, blogPost } from "./schema/drizzle-schema";
import { comment_schema, upvote_schema } from "./schema/fragno-schema";

const { comment } = comment_schema;
const { upvote_total } = upvote_schema;

type User = typeof appUser.$inferSelect;
type NewUser = typeof appUser.$inferInsert;
type NewBlogPost = typeof blogPost.$inferInsert;

// User repository methods
export async function findUserById(id: number) {
  const db = await getDrizzleDatabase();
  const result = await db.select().from(appUser).where(eq(appUser.id, id)).limit(1);
  return result[0];
}

export async function findUserByEmail(email: string) {
  const db = await getDrizzleDatabase();
  const result = await db.select().from(appUser).where(eq(appUser.email, email)).limit(1);
  return result[0];
}

export async function findUsers(criteria: Partial<User>) {
  const db = await getDrizzleDatabase();
  const conditions = [];

  if (criteria.id) {
    conditions.push(eq(appUser.id, criteria.id));
  }

  if (criteria.email) {
    conditions.push(eq(appUser.email, criteria.email));
  }

  if (criteria.name) {
    conditions.push(eq(appUser.name, criteria.name));
  }

  if (criteria.createdAt) {
    conditions.push(eq(appUser.createdAt, criteria.createdAt));
  }

  if (conditions.length === 0) {
    return await db.select().from(appUser);
  }

  return await db
    .select()
    .from(appUser)
    .where(and(...conditions));
}

export async function createUser(newUser: NewUser): Promise<User> {
  const db = await getDrizzleDatabase();
  const result = await db.insert(appUser).values(newUser).returning();
  return result[0];
}

export async function updateUser(id: number, updateWith: Partial<NewUser>) {
  const db = await getDrizzleDatabase();
  await db.update(appUser).set(updateWith).where(eq(appUser.id, id));
}

export async function deleteUser(id: number) {
  const db = await getDrizzleDatabase();
  const result = await db.delete(appUser).where(eq(appUser.id, id)).returning();
  return result[0];
}

// BlogPost repository methods
export async function findBlogPostById(id: number) {
  const db = await getDrizzleDatabase();
  const result = await db.select().from(blogPost).where(eq(blogPost.id, id)).limit(1);
  return result[0];
}

export async function findBlogPostsByAuthor(authorId: number) {
  const db = await getDrizzleDatabase();
  return await db
    .select()
    .from(blogPost)
    .where(eq(blogPost.authorId, authorId))
    .orderBy(desc(blogPost.createdAt));
}

export async function findAllBlogPosts() {
  const db = await getDrizzleDatabase();
  return await db.select().from(blogPost).orderBy(desc(blogPost.createdAt));
}

export async function findBlogPostsWithAuthor() {
  const db = await getDrizzleDatabase();
  const commentRow = aliasedTable(comment, "comment_row");
  return await db
    .select({
      id: blogPost.id,
      title: blogPost.title,
      content: blogPost.content,
      createdAt: blogPost.createdAt,
      updatedAt: blogPost.updatedAt,
      authorId: appUser.id,
      authorName: appUser.name,
      authorEmail: appUser.email,
      comments: sql<Array<typeof comment.$inferSelect>>`json_agg(to_jsonb(${commentRow}))`.as(
        "comments",
      ),
      rating: sql<number>`COALESCE(${upvote_total.total}, 0)`.as("rating"),
    })
    .from(blogPost)
    .innerJoin(appUser, eq(appUser.id, blogPost.authorId))
    .innerJoin(commentRow, eq(commentRow.postReference, sql`${blogPost.id}::text`))
    .leftJoin(upvote_total, eq(upvote_total.reference, sql`${blogPost.id}::text`))
    .orderBy(desc(blogPost.createdAt))
    .groupBy(blogPost.id, appUser.id, upvote_total.total);
}

export async function createBlogPost(post: NewBlogPost) {
  const db = await getDrizzleDatabase();
  const result = await db.insert(blogPost).values(post).returning();
  return result[0];
}

export async function updateBlogPost(id: number, updateWith: Partial<NewBlogPost>) {
  const db = await getDrizzleDatabase();
  await db.update(blogPost).set(updateWith).where(eq(blogPost.id, id));
}

export async function deleteBlogPost(id: number) {
  const db = await getDrizzleDatabase();
  const result = await db.delete(blogPost).where(eq(blogPost.id, id)).returning();
  return result[0];
}

export async function searchBlogPostsByTitle(searchTerm: string) {
  const db = await getDrizzleDatabase();
  return await db
    .select()
    .from(blogPost)
    .where(like(blogPost.title, `%${searchTerm}%`))
    .orderBy(desc(blogPost.createdAt));
}

// ============================================================================
// Complex Relational Queries (demonstrating Fragno relations work properly)
// ============================================================================

/**
 * Fetch auth sessions with their owner users using CONVENIENCE ALIASES.
 * This is the KEY TEST that demonstrates the fix for the relations bug.
 * We're using the 'session' convenience alias from simple_auth_db_schema.
 */
export async function findAuthSessionsWithOwners() {
  const db = await getDrizzleDatabase();
  return await db.query.session.findMany({
    with: {
      sessionOwner: {
        columns: {
          id: true,
          email: true,
          createdAt: true,
        },
      },
    },
    orderBy: (session, { desc }) => [desc(session.createdAt)],
  });
}

/**
 * Fetch a specific auth session with its owner using convenience aliases.
 * This demonstrates that joins work with the aliased tables.
 */
export async function findAuthSessionById(sessionId: string) {
  const db = await getDrizzleDatabase();
  return await db.query.session.findFirst({
    where: (session, { eq }) => eq(session.id, sessionId),
    with: {
      sessionOwner: {
        columns: {
          id: true,
          email: true,
          createdAt: true,
        },
      },
    },
  });
}

/**
 * Fetch auth users with all their sessions using the convenience alias.
 */
export async function findAuthUsersWithSessions() {
  const db = await getDrizzleDatabase();
  return await db.query.user.findMany({
    with: {
      sessionList: {
        orderBy: (session, { desc }) => [desc(session.createdAt)],
      },
    },
  });
}

/**
 * Fetch comments with their nested replies (self-referential relation).
 * This demonstrates that self-referential relations work correctly.
 */
export async function findCommentsWithReplies(postReference: string) {
  const db = await getDrizzleDatabase();
  return await db.query.comment.findMany({
    where: (comment, { eq, isNull }) =>
      and(eq(comment.postReference, postReference), isNull(comment.parentId)),
    with: {
      commentList: {
        // Get first level of nested replies
        orderBy: (comment, { asc }) => [asc(comment.createdAt)],
        with: {
          commentList: {
            // Get second level of nested replies
            orderBy: (comment, { asc }) => [asc(comment.createdAt)],
          },
        },
      },
    },
    orderBy: (comment, { desc }) => [desc(comment.createdAt)],
  });
}

/**
 * Fetch a single comment with its parent and replies.
 * This demonstrates bidirectional self-referential relations.
 */
export async function findCommentWithParentAndReplies(commentId: string) {
  const db = await getDrizzleDatabase();
  return await db.query.comment.findFirst({
    where: (comment, { eq }) => eq(comment.id, commentId),
    with: {
      parent: true,
      commentList: {
        orderBy: (comment, { asc }) => [asc(comment.createdAt)],
      },
    },
  });
}
