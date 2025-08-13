/* eslint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import type { NewFragnoClientHookData } from "./client/client";

declare const useEcho: NewFragnoClientHookData<"GET", "/echo/:message", z.ZodString>;
const _y: NewFragnoClientHookData<"GET", string, StandardSchemaV1<any, any>> = useEcho;
