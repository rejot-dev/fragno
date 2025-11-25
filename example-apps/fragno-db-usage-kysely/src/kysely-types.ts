import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

export interface KyselyDatabase {
  user: UserTable;
  blog_post: BlogPostTable;
  fragno_db_settings: FragnoDbSettingsTable;
  "comment_fragno-db-comment": CommentFragnoDbCommentDbTable;
  "upvote_fragno-db-rating": UpvoteFragnoDbRatingDbTable;
  "upvote_total_fragno-db-rating": UpvoteTotalFragnoDbRatingDbTable;
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

export interface CommentFragnoDbCommentDbTable {
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

export type CommentFragnoDbCommentDb = Selectable<CommentFragnoDbCommentDbTable>;
export type NewCommentFragnoDbCommentDb = Insertable<CommentFragnoDbCommentDbTable>;
export type CommentFragnoDbCommentDbUpdate = Updateable<CommentFragnoDbCommentDbTable>;

export interface UpvoteFragnoDbRatingDbTable {
  id: string;
  reference: string;
  ownerReference: string | null;
  rating: number;
  createdAt: ColumnType<Date, string | undefined, never>;
  note: string | null;
  _internalId: Generated<number>;
  _version: Generated<number>;
}

export type UpvoteFragnoDbRatingDb = Selectable<UpvoteFragnoDbRatingDbTable>;
export type NewUpvoteFragnoDbRatingDb = Insertable<UpvoteFragnoDbRatingDbTable>;
export type UpvoteFragnoDbRatingDbUpdate = Updateable<UpvoteFragnoDbRatingDbTable>;

export interface UpvoteTotalFragnoDbRatingDbTable {
  id: string;
  reference: string;
  total: Generated<number>;
  _internalId: Generated<number>;
  _version: Generated<number>;
}

export type UpvoteTotalFragnoDbRatingDb = Selectable<UpvoteTotalFragnoDbRatingDbTable>;
export type NewUpvoteTotalFragnoDbRatingDb = Insertable<UpvoteTotalFragnoDbRatingDbTable>;
export type UpvoteTotalFragnoDbRatingDbUpdate = Updateable<UpvoteTotalFragnoDbRatingDbTable>;
