CREATE TABLE "form_forms" (
	"id" varchar(30) NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"slug" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"dataSchema" json NOT NULL,
	"uiSchema" json NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"_internalId" bigserial PRIMARY KEY NOT NULL,
	"_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "response_forms" (
	"id" varchar(30) NOT NULL,
	"formId" bigint NOT NULL,
	"formVersion" integer NOT NULL,
	"data" json NOT NULL,
	"submittedAt" timestamp DEFAULT now() NOT NULL,
	"userAgent" text,
	"ip" text,
	"_internalId" bigserial PRIMARY KEY NOT NULL,
	"_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "response_forms" ADD CONSTRAINT "fk_response_form_responseForm_forms" FOREIGN KEY ("formId") REFERENCES "public"."form_forms"("_internalId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_form_status_forms" ON "form_forms" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_form_slug_forms" ON "form_forms" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_response_form_forms" ON "response_forms" USING btree ("formId");