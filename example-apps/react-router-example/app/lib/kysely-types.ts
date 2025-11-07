import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

export interface KyselyDatabase {
  fragno_db_settings: FragnoDbSettingsTable;
  "comment_fragno-db-comment-db": CommentFragnoDbCommentDbTable;
}

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
