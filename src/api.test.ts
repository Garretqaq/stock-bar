import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiErrorText,
  codeOf,
  cumAmount,
  fetchQuotes,
  fetchTrend,
  getActiveSource,
  marketTag,
  pickTrendDay,
  regionOf,
  sessionStatus,
  tencentCode,
  type TrendRawPoint,
} from "./api";

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

describe("分时成交额", () => {
  const p = (date: string, time: string, amount: number | null): TrendRawPoint => ({
    date,
    time,
    price: 3000,
    avg: null,
    vol: null,
    amount,
  });
  // 上一交易日 4 分钟（完整一天），当日只走到第 2 分钟；接口的 trendsTotal 是两天之和
  const raw: TrendRawPoint[] = [
    p("2026-10-13", "0930", 1e9),
    p("2026-10-13", "0931", 2e9),
    p("2026-10-13", "0932", 3e9),
    p("2026-10-13", "1500", 4e9),
    p("2026-10-14", "0930", 5e9),
    p("2026-10-14", "0931", 6e9),
  ];

  it("cumAmount 按条数累加，不传条数就是全部", () => {
    expect(cumAmount(raw.slice(0, 4))).toBe(10e9);
    expect(cumAmount(raw.slice(0, 4), 2)).toBe(3e9);
    // 中间夹着 null 的分钟不影响后面的累加
    const gap = [p("d", "0930", 1e9), p("d", "0931", null), p("d", "0932", 2e9)];
    expect(cumAmount(gap, 3)).toBe(3e9);
    expect(cumAmount([p("d", "0930", null)])).toBeNull();
  });

  it("days=1 时原样交给图表，不做成交额对比", () => {
    const day = pickTrendDay(raw.slice(4), 4, 1);
    expect(day.points.map((x) => x.time)).toEqual(["0930", "0931"]);
    expect(day.total).toBe(4);
    expect([day.amount, day.prevAmount, day.prevDate]).toEqual([null, null, null]);
  });

  it("days=2 时只画最新一天，横轴按整日分钟数铺满", () => {
    const day = pickTrendDay(raw, 8, 2); // 两天各 4 分钟
    expect(day.points.map((x) => x.time)).toEqual(["0930", "0931"]);
    expect(day.total).toBe(4);
  });

  it("算出当日累计与上一日相同时长的累计", () => {
    const day = pickTrendDay(raw, 8, 2);
    expect(day.amount).toBe(11e9);
    // 上一日只累加到当日同样的时长（2 分钟），后面的 09:32、15:00 不算
    expect(day.prevAmount).toBe(3e9);
    expect(day.prevDate).toBe("2026-10-13");
  });

  it("接口只给单日 trendsTotal 时横轴不退化", () => {
    expect(pickTrendDay(raw, 4, 2).total).toBe(4);
  });

  it("只有一天数据时没有同期对比", () => {
    const day = pickTrendDay(raw.slice(4), 4, 2);
    expect(day.amount).toBe(11e9);
    expect(day.prevAmount).toBeNull();
    expect(day.prevDate).toBeNull();
    expect(day.total).toBe(4);
  });

  it("上一日比当日短（半日市等）时不做对比，避免失真", () => {
    const half = [
      p("2026-10-13", "0930", 1e9),
      p("2026-10-13", "0931", 1e9),
      p("2026-10-14", "0930", 2e9),
      p("2026-10-14", "0931", 2e9),
      p("2026-10-14", "0932", 2e9),
    ];
    const day = pickTrendDay(half, 8, 2);
    expect(day.amount).toBe(6e9);
    expect(day.prevAmount).toBeNull();
  });

  it("成交额字段缺失时返回 null，界面据此不显示", () => {
    const day = pickTrendDay([p("2026-10-13", "0930", null), p("2026-10-14", "0930", null)], 2, 2);
    expect([day.amount, day.prevAmount]).toEqual([null, null]);
  });
});

describe("行情失败分类", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("HTTP 5xx 归为源站故障，带上状态码", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    const e = await fetchQuotes(["1.600519"]).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe("server");
    expect(e.status).toBe(502);
    expect(apiErrorText(e)).toBe("行情源故障（HTTP 502），正在重试…");
  });

  it("200 但响应不是 JSON（如被网关替换的页面）也算源站故障", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>")));
    const e = await fetchQuotes(["1.600519"]).catch((x) => x);
    expect([e.kind, e.status]).toEqual(["server", null]);
    expect(apiErrorText(e)).toBe("行情源故障，正在重试…");
  });

  it("连不上归为网络异常", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const e = await fetchQuotes(["1.600519"]).catch((x) => x);
    expect(e.kind).toBe("network");
    expect(apiErrorText(e)).toBe("网络异常，正在重试…");
  });

  it("接口被掐断但域名根路径能响应 → 判为源站故障而非网络异常", async () => {
    // 复现 push2 故障时的现象：浏览器只会给一个 TypeError，无从区分 CORS/掐断
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (new URL(url).pathname === "/") return new Response("", { status: 404 });
      throw new TypeError("Failed to fetch");
    }));
    const e = await fetchQuotes(["1.600519"]).catch((x) => x);
    expect(e.kind).toBe("server");
    expect(e.status).toBeNull();
    expect(apiErrorText(e)).toBe("行情源故障，正在重试…");
  });

  it("AbortError（8 秒超时）归为超时", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }));
    const e = await fetchQuotes(["1.600519"]).catch((x) => x);
    expect(e.kind).toBe("timeout");
    expect(apiErrorText(e)).toBe("请求超时，正在重试…");
  });

  it("不认识的错误退回通用提示", () => {
    expect(apiErrorText(new Error("boom"))).toBe("行情获取失败，正在重试…");
    expect(apiErrorText("boom")).toBe("行情获取失败，正在重试…");
  });
});

describe("数据源与自动降级", () => {
  afterEach(() => vi.unstubAllGlobals());

  const emBody = { data: { diff: [{ f2: 10, f3: 1, f4: 0.1, f12: "600519", f13: 1, f14: "东财名", f124: 1 }] } };
  // 腾讯格式：v_sh600519="1~名称~600519~最新价~昨收~...~时间~涨跌额~涨跌幅%";
  // 响应是 GBK：只把名称字段换成 GBK 字节，其余 ASCII 保持原样。
  // 测试里只用到「腾讯名」这一个中文名，直接写它的 GBK 字节（腾 ccda / 讯 d1b6 / 名 c3fb）。
  // 字段顺序：0=市场标记 1=名称 2=代码 3=最新价 4=昨收 … 30=时间 31=涨跌额 32=涨跌幅
  const TX_NAME = "腾讯名";
  const TX_NAME_GBK = Uint8Array.from([0xcc, 0xda, 0xd1, 0xb6, 0xc3, 0xfb]);
  const txResponse = () => {
    const p = new Array(33).fill("");
    p[0] = "1"; p[2] = "600519"; p[3] = "11.11"; p[4] = "11.00";
    p[30] = "20261014120535"; p[31] = "0.11"; p[32] = "1.00";
    const head = new TextEncoder().encode(`v_sh600519="1~`);   // 到名称字段之前
    const rest = new TextEncoder().encode(`~` + p.slice(2).join("~") + `";`); // 名称字段之后
    const out = new Uint8Array(head.length + TX_NAME_GBK.length + rest.length);
    out.set(head, 0);
    out.set(TX_NAME_GBK, head.length);
    out.set(rest, head.length + TX_NAME_GBK.length);
    return out;
  };

  it("tencentCode 覆盖各市场，北交所用 bj 前缀", () => {
    expect(tencentCode("1.600519")).toBe("sh600519");
    expect(tencentCode("0.300750")).toBe("sz300750");
    expect(tencentCode("0.920001")).toBe("bj920001");
    expect(tencentCode("116.00700")).toBe("hk00700");
    expect(tencentCode("105.AAPL")).toBe("usAAPL");
    expect(tencentCode("100.NDX")).toBe("usNDX");
    expect(tencentCode("100.HSI")).toBe("hkHSI");
    expect(tencentCode("90.BK0001")).toBeNull();
  });

  it("source=tencent 只打腾讯，不漏到东财", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(u);
      return new Response(txResponse());
    }));
    const got = await fetchQuotes(["1.600519"], "tencent");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("qt.gtimg.cn");
    expect(got.get("1.600519")?.name).toBe(TX_NAME);
  });

  it("source=eastmoney 只打东财，失败也不切腾讯", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(u);
      if (new URL(u).pathname === "/") return new Response("", { status: 404 });
      return new Response("", { status: 502 });
    }));
    await expect(fetchQuotes(["1.600519"], "eastmoney")).rejects.toThrow("HTTP 502");
    expect(urls.every((u) => !u.includes("gtimg.cn"))).toBe(true);
  });

  it("auto：东财失败后自动切腾讯并拿到数据", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(u);
      if (u.includes("push2.eastmoney.com")) {
        return new URL(u).pathname === "/" ? new Response("", { status: 404 }) : new Response("", { status: 502 });
      }
      return new Response(txResponse());
    }));
    const got = await fetchQuotes(["1.600519"], "auto");
    expect(got.get("1.600519")?.name).toBe(TX_NAME);
    expect(getActiveSource()).toBe("tencent");
    expect(urls.some((u) => u.includes("push2.eastmoney.com"))).toBe(true);
  });

  it("auto：东财成功时不碰腾讯", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify(emBody));
    }));
    const got = await fetchQuotes(["1.600519"], "auto");
    expect(got.get("1.600519")?.name).toBe("东财名");
    expect(getActiveSource()).toBe("eastmoney");
    expect(urls.every((u) => !u.includes("gtimg.cn"))).toBe(true);
  });
});

describe("腾讯映射与分时修正", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("海外指数查表映射，未收录的返回 null（宁缺勿错）", () => {
    expect(tencentCode("100.NDX")).toBe("usNDX");
    expect(tencentCode("100.DJIA")).toBe("usDJI");
    expect(tencentCode("100.SPX")).toBe("us.INX");
    expect(tencentCode("100.HSI")).toBe("hkHSI");
    expect(tencentCode("100.HSTECH")).toBe("hkHSTECH");
    // 这些在腾讯没有对应标的（或会解析到别的标的），必须返回 null 而不是拼一个看着像的代码
    expect(tencentCode("100.N225")).toBeNull();
    expect(tencentCode("100.XXXX")).toBeNull();
    // 大小写不敏感
    expect(tencentCode("100.ndx")).toBe("usNDX");
  });

  const trendBody = (rows: string[], code = "sh600519") =>
    JSON.stringify({
      data: {
        [code]: {
          data: [{ date: "20261014", data: rows }],
          qt: { [code]: ["1", "X", "600519", "10", "9"] },
        },
      },
    });

  it("午休重复点只保留一条，整日点数与东财一致", async () => {
    // 1130 与 1300 内容相同 → 只留 1130
    const rows = ["0930 10 100 1000", "1130 11 200 2000", "1300 11 200 2000", "1500 12 300 3000"];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(trendBody(rows))));
    const t = await fetchTrend("1.600519", 1, "tencent");
    expect(t.points.map((p) => p.time)).toEqual(["0930", "1130", "1500"]);
  });

  it("累计额回退的坏行不会让当日成交额翻倍", async () => {
    // 第三条累计额回退（坏行）：该分钟记 null，且不污染后续差分基准
    const rows = ["0930 10 100 1000", "0931 10 200 3000", "0932 10 300 500", "0933 10 400 6000"];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(trendBody(rows))));
    // 累计成交额只在 days=2（大盘指数面板）时统计，与东财口径一致
    const t = await fetchTrend("1.600519", 2, "tencent");
    // 正常增量 1000 + 2000 + (坏行跳过) + 3000 = 6000；若让基准跟着回退会算成 1000+2000+5500
    expect(t.amount).toBe(6000);
    // 坏行的均价也要丢掉，避免把 y 轴拉到 0
    expect(t.points[2].avg).toBeNull();
  });

  it("指数不生成均价（腾讯指数的量口径不同）", async () => {
    const rows = ["0930 3800 100 380000", "0931 3801 200 760200"];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(trendBody(rows, "sh000001"))));
    const t = await fetchTrend("1.000001", 1, "tencent");
    expect(t.points.every((p) => p.avg === null)).toBe(true);
  });

  it("个股均价 = 累计额 / (累计量 × 100)", async () => {
    const rows = ["0930 10 100 100000"]; // 100 手 = 10000 股，均价 10
    vi.stubGlobal("fetch", vi.fn(async () => new Response(trendBody(rows))));
    const t = await fetchTrend("1.600519", 1, "tencent");
    expect(t.points[0].avg).toBe(10);
  });

  it("上一日偏短时横轴仍按整日铺满，不超出整日长度", async () => {
    // 上一日只有 2 点、当日 4 点：按「两天之和 - 上一日」会得到 6 > 4
    const body = JSON.stringify({
      data: {
        sh600519: {
          data: [
            { date: "20261013", data: ["0930 10 100 1000", "0931 10 200 2000"] },
            {
              date: "20261014",
              data: ["0930 10 100 1000", "0931 10 200 2000", "0932 10 300 3000", "0933 10 400 4000"],
            },
          ],
          qt: { sh600519: ["1", "X", "600519", "10", "9"] },
        },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    const t = await fetchTrend("1.600519", 2, "tencent");
    expect(t.points).toHaveLength(4);
    // total 取「最长的一天」，不能被算成 6
    expect(t.total).toBe(4);
  });
});
