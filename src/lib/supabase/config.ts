import type { CookieOptionsWithName } from "@supabase/ssr";

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

export const authCookieOptions: CookieOptionsWithName = {
  path: "/",
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: ONE_YEAR_IN_SECONDS,
};

