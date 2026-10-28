-- How each person reaches an organization: as one of its members, or as a member of the firm that
-- manages it. Backoffice lets a firm's members act in its clients without becoming their members,
-- so those rows stay out of the client's members and of the person's own places.
ALTER TABLE "membership"
ADD COLUMN "through" TEXT NOT NULL DEFAULT 'membership' CHECK ("through" IN ('membership', 'firm'));
