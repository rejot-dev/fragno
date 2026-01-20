import type { Prisma, User } from "@prisma/client";
import { getPrismaClient } from "./database";

const prisma = getPrismaClient();

type UserCriteria = Partial<Pick<User, "id" | "email" | "name" | "createdAt">>;
type UserUpdate = { email?: string; name?: string };
type NewUser = Pick<Prisma.UserCreateInput, "email" | "name">;

type NewBlogPost = {
  title: string;
  content: string;
  authorId: number;
};

type BlogPostUpdate = {
  title?: string;
  content?: string;
};

// User repository methods
export async function findUserById(id: number) {
  return prisma.user.findUnique({
    where: { id },
  });
}

export async function findUserByEmail(email: string) {
  return prisma.user.findUnique({
    where: { email },
  });
}

export async function findUsers(criteria: UserCriteria) {
  const where: Prisma.UserWhereInput = {};

  if (criteria.id) {
    where.id = criteria.id;
  }

  if (criteria.email) {
    where.email = criteria.email;
  }

  if (criteria.name) {
    where.name = criteria.name;
  }

  if (criteria.createdAt) {
    where.createdAt = criteria.createdAt;
  }

  return prisma.user.findMany({
    where: Object.keys(where).length ? where : undefined,
  });
}

export async function createUser(newUser: NewUser) {
  return prisma.user.create({
    data: {
      email: newUser.email,
      name: newUser.name,
    },
  });
}

export async function updateUser(id: number, updateWith: UserUpdate) {
  return prisma.user.update({
    where: { id },
    data: updateWith,
  });
}

export async function deleteUser(id: number) {
  return prisma.user.delete({
    where: { id },
  });
}

// BlogPost repository methods
export async function findBlogPostById(id: number) {
  return prisma.blogPost.findUnique({
    where: { id },
  });
}

export async function findBlogPostsByAuthor(authorId: number) {
  return prisma.blogPost.findMany({
    where: { authorId },
    orderBy: { createdAt: "desc" },
  });
}

export async function findAllBlogPosts() {
  return prisma.blogPost.findMany({
    orderBy: { createdAt: "desc" },
  });
}

export async function findBlogPostsWithAuthor() {
  return prisma.blogPost.findMany({
    include: { author: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function createBlogPost(post: NewBlogPost) {
  return prisma.blogPost.create({
    data: {
      title: post.title,
      content: post.content,
      author: {
        connect: { id: post.authorId },
      },
    },
  });
}

export async function updateBlogPost(id: number, updateWith: BlogPostUpdate) {
  return prisma.blogPost.update({
    where: { id },
    data: updateWith,
  });
}

export async function deleteBlogPost(id: number) {
  return prisma.blogPost.delete({
    where: { id },
  });
}

export async function searchBlogPostsByTitle(searchTerm: string) {
  return prisma.blogPost.findMany({
    where: {
      title: {
        contains: searchTerm,
      },
    },
    orderBy: { createdAt: "desc" },
  });
}
