import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

export interface KyselyDatabase {
  user: UserTable;
  blog_post: BlogPostTable;
  fragno_db_settings: FragnoDbSettingsTable;
  "comment.comment": CommentCommentTable;
  "upvote.upvote": UpvoteUpvoteTable;
  "upvote.upvote_total": UpvoteTotalUpvoteTable;
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

export interface FragnoDbSettingsTable {
  id: string;
  key: string;
  value: string;
  _internalId: Generated<number>;
  _version: Generated<number>;
}

export type FragnoDbSettings = Selectable<FragnoDbSettingsTable>;
export type NewFragnoDbSettings = Insertable<FragnoDbSettingsTable>;
export type FragnoDbSettingsUpdate = Updateable<FragnoDbSettingsTable>;

export interface CommentCommentTable {
  id: string;
  title: string;
  content: string;
  createdAt: ColumnType<Date, string | undefined, never>;
  postReference: string;
  userReference: string;
  parentId: number | null;
  rating: Generated<number>;
  _internalId: Generated<number>;
  _version: Generated<number>;
}

export type CommentComment = Selectable<CommentCommentTable>;
export type NewCommentComment = Insertable<CommentCommentTable>;
export type CommentCommentUpdate = Updateable<CommentCommentTable>;

export interface UpvoteUpvoteTable {
  id: string;
  reference: string;
  ownerReference: string | null;
  rating: number;
  createdAt: ColumnType<Date, string | undefined, never>;
  note: string | null;
  _internalId: Generated<number>;
  _version: Generated<number>;
}

export type UpvoteUpvote = Selectable<UpvoteUpvoteTable>;
export type NewUpvoteUpvote = Insertable<UpvoteUpvoteTable>;
export type UpvoteUpvoteUpdate = Updateable<UpvoteUpvoteTable>;

export interface UpvoteTotalUpvoteTable {
  id: string;
  reference: string;
  total: Generated<number>;
  _internalId: Generated<number>;
  _version: Generated<number>;
}

export type UpvoteTotalUpvote = Selectable<UpvoteTotalUpvoteTable>;
export type NewUpvoteTotalUpvote = Insertable<UpvoteTotalUpvoteTable>;
export type UpvoteTotalUpvoteUpdate = Updateable<UpvoteTotalUpvoteTable>;
