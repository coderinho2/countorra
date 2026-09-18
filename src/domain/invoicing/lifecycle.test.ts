import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  canTransition,
  daysOverdue,
  deriveInvoiceState,
  dueDateFrom,
  isRemindable,
  isSettled,
  isStoredStatus,
  type StoredInvoiceStatus,
} from "./lifecycle";

/**
 * The invoice state machine.
 *
 * Every refusal here corresponds to a false statement about money that the
 * previous unguarded status setter allowed: a paid invoice returning to
 * draft, a voided one being marked paid, a draft the customer never saw
 * being marked paid.
 */

const ALL: StoredInvoiceStatus[] = ["draft", "sent", "paid", "void"];

describe("transitions", () => {
  it("lets a draft be sent or abandoned", () => {
    expect([...allowedTransitions("draft")].sort()).toEqual(["sent", "void"]);
  });

  it("lets a sent invoice be settled or cancelled", () => {
    expect([...allowedTransitions("sent")].sort()).toEqual(["paid", "void"]);
  });

  it("treats paid and void as terminal", () => {
    expect(allowedTransitions("paid")).toEqual([]);
    expect(allowedTransitions("void")).toEqual([]);
    expect(isSettled("paid")).toBe(true);
    expect(isSettled("void")).toBe(true);
  });

  it("NEVER lets a sent invoice return to draft", () => {
    // The customer is holding a copy. Editing it afterwards would make their
    // copy and ours disagree about what is owed.
    expect(canTransition("sent", "draft")).toBe(false);
  });

  it("never lets a paid invoice be un-paid or voided", () => {
    expect(canTransition("paid", "sent")).toBe(false);
    expect(canTransition("paid", "draft")).toBe(false);
    expect(canTransition("paid", "void")).toBe(false);
  });

  it("never lets a voided invoice be paid", () => {
    expect(canTransition("void", "paid")).toBe(false);
    expect(canTransition("void", "sent")).toBe(false);
  });

  it("never lets a draft skip straight to paid", () => {
    // It was never sent. Marking it paid records money against a demand the
    // customer never received.
    expect(canTransition("draft", "paid")).toBe(false);
  });

  it("refuses every self-transition", () => {
    for (const status of ALL) expect(canTransition(status, status), status).toBe(false);
  });

  it("permits exactly four transitions in total", () => {
    const permitted = ALL.flatMap((from) => ALL.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`));
    expect(permitted.sort()).toEqual(["draft->sent", "draft->void", "sent->paid", "sent->void"]);
  });
});

describe("isStoredStatus", () => {
  it.each(ALL)("accepts %s", (status) => {
    expect(isStoredStatus(status)).toBe(true);
  });

  it("REJECTS overdue, which is derived rather than set", () => {
    // The enum has the value and nothing writes it. Accepting it here would
    // let a human pin an invoice as overdue after the customer had paid.
    expect(isStoredStatus("overdue")).toBe(false);
  });

  it.each(["", "PAID", "paid ", "sent;", null, undefined, 3, {}])("rejects %s", (value) => {
    expect(isStoredStatus(value)).toBe(false);
  });
});

describe("deriveInvoiceState", () => {
  const on = (iso: string) => new Date(`${iso}T12:00:00Z`);

  it("reports a sent invoice past its due date as overdue", () => {
    expect(deriveInvoiceState({ status: "sent", dueDate: "2026-09-01" }, on("2026-09-02"))).toBe("overdue");
  });

  it("does NOT treat the due date itself as late", () => {
    // Due ON a date means due at the end of it. Calling it late that morning
    // is a complaint from a customer who paid on time.
    expect(deriveInvoiceState({ status: "sent", dueDate: "2026-09-02" }, on("2026-09-02"))).toBe("sent");
  });

  it("compares calendar dates, not instants", () => {
    // Late on the due date in UTC, and any local zone, is still not overdue.
    expect(deriveInvoiceState({ status: "sent", dueDate: "2026-09-02" }, new Date("2026-09-02T23:59:59Z"))).toBe("sent");
  });

  it("never calls a draft overdue", () => {
    // A draft was never sent, so nobody is late paying it.
    expect(deriveInvoiceState({ status: "draft", dueDate: "2020-01-01" }, on("2026-09-02"))).toBe("draft");
  });

  it.each(["paid", "void"] as const)("never calls a %s invoice overdue", (status) => {
    expect(deriveInvoiceState({ status, dueDate: "2020-01-01" }, on("2026-09-02"))).toBe(status);
  });

  it("leaves a sent invoice with no due date as sent", () => {
    expect(deriveInvoiceState({ status: "sent", dueDate: null }, on("2026-09-02"))).toBe("sent");
  });
});

describe("daysOverdue", () => {
  const on = (iso: string) => new Date(`${iso}T00:00:00Z`);

  it("counts whole days past the due date", () => {
    expect(daysOverdue("2026-09-01", on("2026-09-04"))).toBe(3);
  });

  it("is zero on the due date and before it", () => {
    expect(daysOverdue("2026-09-01", on("2026-09-01"))).toBe(0);
    expect(daysOverdue("2026-09-01", on("2026-08-20"))).toBe(0);
  });

  it("is zero with no due date", () => {
    expect(daysOverdue(null, on("2026-09-04"))).toBe(0);
  });

  it("crosses a month boundary correctly", () => {
    expect(daysOverdue("2026-01-31", on("2026-02-02"))).toBe(2);
  });
});

describe("isRemindable", () => {
  it("only chases an invoice the customer actually has", () => {
    expect(isRemindable({ status: "sent" })).toBe(true);
    // Chasing someone for a draft, or for an invoice they already paid, is
    // the kind of mistake that costs a customer.
    expect(isRemindable({ status: "draft" })).toBe(false);
    expect(isRemindable({ status: "paid" })).toBe(false);
    expect(isRemindable({ status: "void" })).toBe(false);
  });
});

describe("dueDateFrom", () => {
  it("adds net terms in whole days", () => {
    expect(dueDateFrom("2026-09-01", 30)).toBe("2026-10-01");
    expect(dueDateFrom("2026-09-01", 0)).toBe("2026-09-01");
  });

  it("crosses a year boundary", () => {
    expect(dueDateFrom("2026-12-20", 30)).toBe("2027-01-19");
  });

  it("handles a leap year", () => {
    expect(dueDateFrom("2028-02-28", 1)).toBe("2028-02-29");
  });
});
