import type { BlogPostUpdate, NewBlogPost, NewUser, User, UserUpdate } from "./kysely-types";
import { getDb } from "./database";

// User repository methods
export async function findUserById(id: number) {
  const db = await getDb();
  return await db.selectFrom("user").where("id", "=", id).selectAll().executeTakeFirst();
}

export async function findUserByEmail(email: string) {
  const db = await getDb();
  return await db.selectFrom("user").where("email", "=", email).selectAll().executeTakeFirst();
}

export async function findUsers(criteria: Partial<User>) {
  const db = await getDb();
  let query = db.selectFrom("user");

  if (criteria.id) {
    query = query.where("id", "=", criteria.id);
  }

  if (criteria.email) {
    query = query.where("email", "=", criteria.email);
  }

  if (criteria.name) {
    query = query.where("name", "=", criteria.name);
  }

  if (criteria.created_at) {
    query = query.where("created_at", "=", criteria.created_at);
  }

  return await query.selectAll().execute();
}

export async function createUser(user: NewUser): Promise<User> {
  const db = await getDb();
  return await db.insertInto("user").values(user).returningAll().executeTakeFirstOrThrow();
}

export async function updateUser(id: number, updateWith: UserUpdate) {
  const db = await getDb();
  await db.updateTable("user").set(updateWith).where("id", "=", id).execute();
}

export async function deleteUser(id: number) {
  const db = await getDb();
  return await db.deleteFrom("user").where("id", "=", id).returningAll().executeTakeFirst();
}

// BlogPost repository methods
export async function findBlogPostById(id: number) {
  const db = await getDb();
  return await db.selectFrom("blog_post").where("id", "=", id).selectAll().executeTakeFirst();
}

export async function findBlogPostsByAuthor(authorId: number) {
  const db = await getDb();
  return await db
    .selectFrom("blog_post")
    .where("author_id", "=", authorId)
    .selectAll()
    .orderBy("created_at", "desc")
    .execute();
}

export async function findAllBlogPosts() {
  const db = await getDb();
  return await db.selectFrom("blog_post").selectAll().orderBy("created_at", "desc").execute();
}

export async function findBlogPostsWithAuthor() {
  const db = await getDb();
  return await db
    .selectFrom("blog_post")
    .innerJoin("user", "user.id", "blog_post.author_id")
    .select([
      "blog_post.id",
      "blog_post.title",
      "blog_post.content",
      "blog_post.created_at",
      "blog_post.updated_at",
      "user.id as author_id",
      "user.name as author_name",
      "user.email as author_email",
    ])
    .orderBy("blog_post.created_at", "desc")
    .execute();
}

export async function createBlogPost(post: NewBlogPost) {
  const db = await getDb();
  return await db.insertInto("blog_post").values(post).returningAll().executeTakeFirstOrThrow();
}

export async function updateBlogPost(id: number, updateWith: BlogPostUpdate) {
  const db = await getDb();
  await db.updateTable("blog_post").set(updateWith).where("id", "=", id).execute();
}

export async function deleteBlogPost(id: number) {
  const db = await getDb();
  return await db.deleteFrom("blog_post").where("id", "=", id).returningAll().executeTakeFirst();
}

export async function searchBlogPostsByTitle(searchTerm: string) {
  const db = await getDb();
  return await db
    .selectFrom("blog_post")
    .where("title", "like", `%${searchTerm}%`)
    .selectAll()
    .orderBy("created_at", "desc")
    .execute();
}
