import type { Command } from "gunshi";
import { createRatingFragmentServer } from "../fragno/rating-fragment";
import { adapter } from "../fragno-adapter";

const ratingUpvoteCommand: Command = {
  name: "upvote",
  description: "Add an upvote to a reference",
  args: {
    reference: {
      type: "string" as const,
      description: "Reference ID to upvote",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const services = createRatingFragmentServer(adapter).services;
    const reference = ctx.values["reference"] as string;

    await services.postUpvote(reference);

    const total = await services.getRating(reference);
    console.log(`Upvoted reference: ${reference}`);
    console.log(`Current rating: ${total}`);
  },
};

const ratingDownvoteCommand: Command = {
  name: "downvote",
  description: "Add a downvote to a reference",
  args: {
    reference: {
      type: "string" as const,
      description: "Reference ID to downvote",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const services = createRatingFragmentServer(adapter).services;
    const reference = ctx.values["reference"] as string;

    await services.postDownvote(reference);

    const total = await services.getRating(reference);
    console.log(`Downvoted reference: ${reference}`);
    console.log(`Current rating: ${total}`);
  },
};

const ratingGetCommand: Command = {
  name: "get",
  description: "Get the current rating for a reference",
  args: {
    reference: {
      type: "string" as const,
      description: "Reference ID to get rating for",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const services = createRatingFragmentServer(adapter).services;
    const reference = ctx.values["reference"] as string;

    const total = await services.getRating(reference);
    console.log(`Rating for reference ${reference}: ${total}`);
  },
};

export const ratingSubCommands = new Map();
ratingSubCommands.set("upvote", ratingUpvoteCommand);
ratingSubCommands.set("downvote", ratingDownvoteCommand);
ratingSubCommands.set("get", ratingGetCommand);

export const ratingCommand: Command = {
  name: "rating",
  description: "Rating/upvote management commands",
  run: () => {
    console.log("Rating/upvote management commands");
    console.log("");
    console.log("Usage: node --import tsx src/mod.ts rating <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  upvote      Add an upvote to a reference");
    console.log("  downvote    Add a downvote to a reference");
    console.log("  get         Get the current rating for a reference");
    console.log("");
    console.log("Run 'node --import tsx src/mod.ts rating <command> --help' for more information.");
  },
};
