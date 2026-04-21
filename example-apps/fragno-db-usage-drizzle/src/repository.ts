import { eq, like, desc, and, sql, aliasedTable } from "drizzle-orm";

import { getDrizzleDatabase } from "./database";
import { appUser, blogPost } from "./schema/drizzle-schema";
import { auth_schema, comment_schema, upvote_schema } from "./schema/fragno-schema";

const { user: authUser, session: authSession } = auth_schema;
const { comment } = comment_schema;
const { upvote_total } = upvote_schema;

type User = typeof appUser.$inferSelect;
type NewUser = typeof appUser.$inferInsert;
type NewBlogPost = typeof blogPost.$inferInsert;
type AuthSession = typeof authSession.$inferSelect;
type AuthUser = typeof authUser.$inferSelect;
type CommentRow = typeof comment.$inferSelect;
type SessionWithOwner = AuthSession & {
  sessionOwner: Pick<AuthUser, "id" | "email" | "createdAt"> | null;
};
type UserWithSessions = AuthUser & { sessionList: AuthSession[] };
type CommentWithReplies = CommentRow & { commentList: CommentWithReplies[] };
type CommentWithParentAndReplies = CommentRow & {
  parent: CommentRow | null;
  commentList: CommentWithReplies[];
};

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
// Explicit relational-style queries (without generated Drizzle relation metadata)
// ============================================================================

function buildCommentReplyTree(comments: CommentRow[]): CommentWithReplies[] {
  const commentsWithReplies = new Map<string, CommentWithReplies>();

  for (const commentRow of comments) {
    commentsWithReplies.set(commentRow.id, { ...commentRow, commentList: [] });
  }

  const rootComments: CommentWithReplies[] = [];

  for (const commentRow of comments) {
    const commentWithReplies = commentsWithReplies.get(commentRow.id);
    if (!commentWithReplies) {
      continue;
    }

    if (!commentRow.parentId) {
      rootComments.push(commentWithReplies);
      continue;
    }

    const parentComment = comments.find(
      (candidate) => candidate._internalId === commentRow.parentId,
    );
    if (!parentComment) {
      rootComments.push(commentWithReplies);
      continue;
    }

    commentsWithReplies.get(parentComment.id)?.commentList.push(commentWithReplies);
  }

  const sortReplies = (commentWithReplies: CommentWithReplies) => {
    commentWithReplies.commentList.sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
    for (const reply of commentWithReplies.commentList) {
      sortReplies(reply);
    }
  };

  rootComments.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  for (const rootComment of rootComments) {
    sortReplies(rootComment);
  }

  return rootComments;
}

export async function findAuthSessionsWithOwners(): Promise<SessionWithOwner[]> {
  const db = await getDrizzleDatabase();
  const rows = await db
    .select({
      session: authSession,
      sessionOwner: {
        id: authUser.id,
        email: authUser.email,
        createdAt: authUser.createdAt,
      },
    })
    .from(authSession)
    .leftJoin(authUser, eq(authUser._internalId, authSession.userId))
    .orderBy(desc(authSession.createdAt));

  return rows.map(({ session, sessionOwner }) => ({
    ...session,
    sessionOwner: sessionOwner?.id ? sessionOwner : null,
  }));
}

export async function findAuthSessionById(sessionId: string): Promise<SessionWithOwner | null> {
  const db = await getDrizzleDatabase();
  const row = (
    await db
      .select({
        session: authSession,
        sessionOwner: {
          id: authUser.id,
          email: authUser.email,
          createdAt: authUser.createdAt,
        },
      })
      .from(authSession)
      .leftJoin(authUser, eq(authUser._internalId, authSession.userId))
      .where(eq(authSession.id, sessionId))
      .limit(1)
  )[0];

  if (!row) {
    return null;
  }

  return {
    ...row.session,
    sessionOwner: row.sessionOwner?.id ? row.sessionOwner : null,
  };
}

export async function findAuthUsersWithSessions(): Promise<UserWithSessions[]> {
  const db = await getDrizzleDatabase();
  const [users, sessions] = await Promise.all([
    db.select().from(authUser).orderBy(desc(authUser.createdAt)),
    db.select().from(authSession).orderBy(desc(authSession.createdAt)),
  ]);

  const sessionsByUserInternalId = new Map<number, AuthSession[]>();
  for (const sessionRow of sessions) {
    const existingSessions = sessionsByUserInternalId.get(sessionRow.userId) ?? [];
    existingSessions.push(sessionRow);
    sessionsByUserInternalId.set(sessionRow.userId, existingSessions);
  }

  return users.map((userRow) => ({
    ...userRow,
    sessionList: sessionsByUserInternalId.get(userRow._internalId) ?? [],
  }));
}

export async function findCommentsWithReplies(
  postReference: string,
): Promise<CommentWithReplies[]> {
  const db = await getDrizzleDatabase();
  const comments = await db
    .select()
    .from(comment)
    .where(eq(comment.postReference, postReference))
    .orderBy(desc(comment.createdAt));

  return buildCommentReplyTree(comments);
}

export async function findCommentWithParentAndReplies(
  commentId: string,
): Promise<CommentWithParentAndReplies | null> {
  const db = await getDrizzleDatabase();
  const currentComment = (
    await db.select().from(comment).where(eq(comment.id, commentId)).limit(1)
  )[0];

  if (!currentComment) {
    return null;
  }

  const [parentComment, commentsForPost] = await Promise.all([
    currentComment.parentId
      ? db
          .select()
          .from(comment)
          .where(eq(comment._internalId, currentComment.parentId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    db.select().from(comment).where(eq(comment.postReference, currentComment.postReference)),
  ]);

  const directReplies = buildCommentReplyTree(commentsForPost).find(
    (candidate) => candidate.id === currentComment.id,
  )?.commentList;

  return {
    ...currentComment,
    parent: parentComment,
    commentList: directReplies ?? [],
  };
}
