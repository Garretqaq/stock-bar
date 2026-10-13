import { afterEach, describe, expect, it, vi } from "vitest";
import { codeOf, fetchQuotes, marketTag, regionOf, sessionStatus } from "./api";

const sec = (iso: string) => Date.parse(iso) / 1000;

describe("secid 工具", () => {
  it("codeOf 取代码部分", () => {
    expect(codeOf("1.600519")).toBe("600519");
    expect(codeOf("105.NVDA")).toBe("NVDA");
  });

  it("marketTag 区分市场，北交所按代码前缀识别", () => {
    expect(marketTag("1.600519")).toBe("SH");
    expect(marketTag("0.300750")).toBe("SZ");
    expect(marketTag("0.830799")).toBe("BJ");
    expect(marketTag("0.920001")).toBe("BJ");
    expect(marketTag("116.00700")).toBe("HK");
    expect(marketTag("106.BABA")).toBe("US");
    expect(marketTag("100.NDX")).toBe("指数");
    expect(marketTag("90.BK0001")).toBe("--");
  });

  it("regionOf：海外指数里 HS 开头算港股", () => {
    expect(regionOf("1.000001")).toBe("CN");
    expect(regionOf("116.00700")).toBe("HK");
    expect(regionOf("105.AAPL")).toBe("US");
    expect(regionOf("100.HSI")).toBe("HK");
    expect(regionOf("100.NDX")).toBe("US");
  });
});

describe("sessionStatus", () => {
  // 2026-10-13 是周二
  it("按时钟判断各时段", () => {
    expect(sessionStatus("CN", new Date("2026-10-13T01:00:00Z")).text).toBe("未开盘"); // 09:00
    expect(sessionStatus("CN", new Date("2026-10-13T02:00:00Z"))).toEqual({ open: true, text: "交易中" }); // 10:00
    expect(sessionStatus("CN", new Date("2026-10-13T04:00:00Z")).text).toBe("午间休市"); // 12:00
    expect(sessionStatus("CN", new Date("2026-10-13T07:30:00Z")).text).toBe("已收盘"); // 15:30
    expect(sessionStatus("CN", new Date("2026-10-17T02:00:00Z")).text).toBe("休市"); // 周六
  });

  it("美股按纽约时区", () => {
    // 纽约 10:00（夏令时 UTC-4）
    expect(sessionStatus("US", new Date("2026-10-13T14:00:00Z")).open).toBe(true);
    expect(sessionStatus("US", new Date("2026-10-13T21:00:00Z")).text).toBe("已收盘");
  });

  it("当日已有成交 → 正常交易中", () => {
    const now = new Date("2026-10-13T02:00:00Z");
    expect(sessionStatus("CN", now, sec("2026-10-13T01:59:00Z")).open).toBe(true);
  });

  it("工作日开盘后最后成交仍是前一交易日 → 节假日休市", () => {
    // 2026-10-01（周四）国庆，最后成交停在 9 月 30 日 15:00
    const now = new Date("2026-10-01T02:00:00Z");
    expect(sessionStatus("CN", now, sec("2026-09-30T07:00:00Z"))).toEqual({ open: false, text: "休市" });
    // 收盘后也应显示休市，而不是"已收盘"
    expect(sessionStatus("CN", new Date("2026-10-01T08:00:00Z"), sec("2026-09-30T07:00:00Z")).text).toBe("休市");
  });

  it("刚开盘的宽限期内不误判节假日", () => {
    const now = new Date("2026-10-13T01:35:00Z"); // 09:35
    expect(sessionStatus("CN", now, sec("2026-10-12T07:00:00Z")).text).toBe("交易中");
  });

  it("开盘前不做节假日判断", () => {
    const now = new Date("2026-10-13T01:00:00Z");
    expect(sessionStatus("CN", now, sec("2026-10-12T07:00:00Z")).text).toBe("未开盘");
  });
});

describe("fetchQuotes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("解析批量报价，'-' 转成 null，带回成交时间", async () => {
    const body = {
      data: {
        diff: [
          { f2: 1500.5, f3: 1.2, f4: 17.8, f12: "600519", f13: 1, f14: "贵州茅台", f124: 1791879120 },
          { f2: "-", f3: "-", f4: "-", f12: "AAPL", f13: 105, f14: "苹果", f124: "-" },
        ],
      },
    };
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(body)));
    vi.stubGlobal("fetch", fetchMock);
    const got = await fetchQuotes(["1.600519", "105.AAPL", "1.600519", ""]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("f124");
    expect(got.get("1.600519")).toEqual({
      secid: "1.600519",
      code: "600519",
      market: 1,
      name: "贵州茅台",
      price: 1500.5,
      pct: 1.2,
      change: 17.8,
      time: 1791879120,
    });
    const aapl = got.get("105.AAPL")!;
    expect([aapl.price, aapl.pct, aapl.change, aapl.time]).toEqual([null, null, null, null]);
  });

  it("空列表不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchQuotes([])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP 错误会抛出", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    await expect(fetchQuotes(["1.600519"])).rejects.toThrow("HTTP 502");
  });
});
