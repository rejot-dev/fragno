import { stripeFragment } from "@/lib/stripe";

const res = await stripeFragment.callServices(() => stripeFragment.services.getAllSubscriptions());
console.log(res);
