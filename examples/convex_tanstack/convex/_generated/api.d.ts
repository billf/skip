/* eslint-disable */
import type * as workspace from "../workspace.js";
import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
declare const fullApi: ApiFromModules<{ workspace: typeof workspace }>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
export declare const components: {};
