import { eq, like, desc, and, sql } from "drizzle-orm";
import { db } from "./database";
import { user, blogPost } from "./schema/drizzle-schema";
import { comment } from "./schema/comment-fragment-schema";

type User = typeof user.$inferSelect;
type NewUser = typeof user.$inferInsert;
type NewBlogPost = typeof blogPost.$inferInsert;

// User repository methods
export async function findUserById(id: number) {
  const result = await db.select().from(user).where(eq(user.id, id)).limit(1);
  return result[0];
}

export async function findUserByEmail(email: string) {
  const result = await db.select().from(user).where(eq(user.email, email)).limit(1);
  return result[0];
}

export async function findUsers(criteria: Partial<User>) {
  const conditions = [];

  if (criteria.id) {
    conditions.push(eq(user.id, criteria.id));
  }

  if (criteria.email) {
    conditions.push(eq(user.email, criteria.email));
  }

  if (criteria.name) {
    conditions.push(eq(user.name, criteria.name));
  }

  if (criteria.createdAt) {
    conditions.push(eq(user.createdAt, criteria.createdAt));
  }

  if (conditions.length === 0) {
    return await db.select().from(user);
  }

  return await db
    .select()
    .from(user)
    .where(and(...conditions));
}

export async function createUser(newUser: NewUser): Promise<User> {
  const result = await db.insert(user).values(newUser).returning();
  return result[0];
}

export async function updateUser(id: number, updateWith: Partial<NewUser>) {
  await db.update(user).set(updateWith).where(eq(user.id, id));
}

export async function deleteUser(id: number) {
  const result = await db.delete(user).where(eq(user.id, id)).returning();
  return result[0];
}

// BlogPost repository methods
export async function findBlogPostById(id: number) {
  const result = await db.select().from(blogPost).where(eq(blogPost.id, id)).limit(1);
  return result[0];
}

export async function findBlogPostsByAuthor(authorId: number) {
  return await db
    .select()
    .from(blogPost)
    .where(eq(blogPost.authorId, authorId))
    .orderBy(desc(blogPost.createdAt));
}

export async function findAllBlogPosts() {
  return await db.select().from(blogPost).orderBy(desc(blogPost.createdAt));
}

export async function findBlogPostsWithAuthor() {
  return await db
    .select({
      id: blogPost.id,
      title: blogPost.title,
      content: blogPost.content,
      createdAt: blogPost.createdAt,
      updatedAt: blogPost.updatedAt,
      authorId: user.id,
      authorName: user.name,
      authorEmail: user.email,
      comments: sql<Array<typeof comment.$inferSelect>>`json_agg(comment)`.as("comments"),
    })
    .from(blogPost)
    .innerJoin(user, eq(user.id, blogPost.authorId))
    .innerJoin(comment, eq(comment.postReference, sql`${blogPost.id}::text`))
    .orderBy(desc(blogPost.createdAt))
    .groupBy(blogPost.id, user.id);
}

export async function createBlogPost(post: NewBlogPost) {
  const result = await db.insert(blogPost).values(post).returning();
  return result[0];
}

export async function updateBlogPost(id: number, updateWith: Partial<NewBlogPost>) {
  await db.update(blogPost).set(updateWith).where(eq(blogPost.id, id));
}

export async function deleteBlogPost(id: number) {
  const result = await db.delete(blogPost).where(eq(blogPost.id, id)).returning();
  return result[0];
}

export async function searchBlogPostsByTitle(searchTerm: string) {
  return await db
    .select()
    .from(blogPost)
    .where(like(blogPost.title, `%${searchTerm}%`))
    .orderBy(desc(blogPost.createdAt));
}
