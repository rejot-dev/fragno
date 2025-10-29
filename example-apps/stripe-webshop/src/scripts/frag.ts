import { stripeFragment } from "@/lib/stripe";

const res = await stripeFragment.services.getAllSubscriptions();
console.log(res);
