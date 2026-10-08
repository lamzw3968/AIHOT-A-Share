// A daily's front-page picture comes from the item its lead is about: the editors' lead matched to an
// item by title, never simply the first highlight.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportCitation } from "@aihot/contracts/site";
import { leadItemOf } from "@aihot/backend/publication/reports";

const cite = (itemId: string, title: string) => ({ itemId, title }) as ReportCitation;
const earnings = cite("a", "虚构甲公司上半年营业收入5亿元，净利润同比增长30%");
const exchange = cite("b", "上交所调整交易规则，明确申报数量、执行时间和公开披露要求");

test("an editors' lead is matched to the item it is written about", () => {
  assert.equal(leadItemOf("上交所调整交易规则，明确公开披露要求", [earnings, exchange], [earnings, exchange])?.itemId, "b");
});

test("a lead that matches no item clearly has no item", () => {
  assert.equal(leadItemOf("多家公司签署订单，产业需求变化", [earnings], [earnings, exchange]), undefined);
});

test("without an editors' lead the first highlight leads", () => {
  assert.equal(leadItemOf(undefined, [earnings], [exchange, earnings])?.itemId, "a");
});
