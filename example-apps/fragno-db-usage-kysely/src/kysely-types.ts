import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

export interface KyselyDatabase {
  user: UserTable;
  blog_post: BlogPostTable;
}

export interface UserTable {
  id: Generated<number>;
  email: string;
  name: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

export type User = Selectable<UserTable>;
export type NewUser = Insertable<UserTable>;
export type UserUpdate = Updateable<UserTable>;

export interface BlogPostTable {
  id: Generated<number>;
  title: string;
  content: string;
  author_id: number;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, never>;
}

export type BlogPost = Selectable<BlogPostTable>;
export type NewBlogPost = Insertable<BlogPostTable>;
export type BlogPostUpdate = Updateable<BlogPostTable>;
