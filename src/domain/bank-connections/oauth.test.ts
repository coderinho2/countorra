import { describe, expect, it } from "vitest";
import { BANK_OAUTH_RETURN_PATH, checkBankOauthReturnUri } from "./oauth";

describe("the one bank OAuth return URI", () => {
  it("is a fixed path that names no organization", () => {
    expect(BANK_OAUTH_RETURN_PATH).toBe("/app/bank-connections/oauth");
  });

  it.each(["https://countorra.example/app/bank-connections/oauth", "https://staging.countorra.example/app/bank-connections/oauth", "http://localhost:3000/app/bank-connections/oauth"])(
    "accepts %s",
    (uri) => expect(checkBankOauthReturnUri(uri)).toEqual({ ok: true }),
  );

  it.each([
    ["the old per-organization path", "https://countorra.example/app/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bank-connections/oauth", "wrong_path"],
    ["an organization in the query", "https://countorra.example/app/bank-connections/oauth?org=aaaaaaaa", "has_query_or_fragment"],
    ["a fragment", "https://countorra.example/app/bank-connections/oauth#x", "has_query_or_fragment"],
    ["a trailing slash", "https://countorra.example/app/bank-connections/oauth/", "wrong_path"],
    ["plain http on a real host", "http://countorra.example/app/bank-connections/oauth", "not_https"],
    ["not a URL", "app/bank-connections/oauth", "not_a_url"],
  ])("refuses %s", (_label, uri, problem) => {
    expect(checkBankOauthReturnUri(uri)).toEqual({ ok: false, problem });
  });
});
