import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiErrorText,
  boardSourceOf,
  codeOf,
  cumAmount,
  fetchBoards,
  fetchMarketAmount,
  fetchQuotes,
  fetchTrend,
  getActiveSource,
  isBoardSecid,
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
          { f2: 1500.5, f3: 1.2, f4: 17.8, f6: 6.6e9, f12: "600519", f13: 1, f14: "贵州茅台", f124: 1791879120 },
          { f2: "-", f3: "-", f4: "-", f12: "AAPL", f13: 105, f14: "苹果", f124: "-" },
        ],
      },
    };
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(body)));
    vi.stubGlobal("fetch", fetchMock);
    const got = await fetchQuotes(["1.600519", "105.AAPL", "1.600519", ""]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("f6");
    expect(got.get("1.600519")).toEqual({
      secid: "1.600519",
      code: "600519",
      market: 1,
      name: "贵州茅台",
      price: 1500.5,
      pct: 1.2,
      change: 17.8,
      time: 1791879120,
      amount: 6.6e9,
    });
    const aapl = got.get("105.AAPL")!;
    expect([aapl.price, aapl.pct, aapl.change, aapl.time, aapl.amount]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
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
    const p = new Array(38).fill("");
    p[0] = "1"; p[2] = "600519"; p[3] = "11.11"; p[4] = "11.00";
    p[30] = "20261014120535"; p[31] = "0.11"; p[32] = "1.00";
    p[37] = "66249184"; // 成交额（万元）→ 6624.9 亿
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

describe("全市场成交额", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** 直接用报价 Map 构造，避免依赖接口路径 */
  const quotesOf = (parts: Partial<Record<string, number | null>>) => {
    const m = new Map<string, any>();
    for (const [id, amount] of Object.entries(parts)) {
      m.set(id, { secid: id, amount });
    }
    // 沪深两市的「上一日同期」走 fetchTrend，测试里单独 stub
    return m;
  };

  const trendStub = (shPrev: number | null, szPrev: number | null) =>
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      const isSh = u.includes("000001");
      const prev = isSh ? shPrev : szPrev;
      const rows = prev == null ? [] : [
        { date: "20261013", data: ["0930 10 100 1000", "0931 10 200 3000"] },
        { date: "20261014", data: ["0930 10 100 1000", "0931 10 200 3000"] },
      ];
      const code = isSh ? "sh000001" : "sz399001";
      // prev 值通过分时累计额体现：把上一日累计额设成目标值
      if (prev != null) rows[0].data = [`0930 10 100 ${prev}`];
      return new Response(JSON.stringify({ data: { [code]: { data: rows, qt: { [code]: ["1", "X"] } } } }));
    }));

  it("三市齐全才给出全市场总额，并单独给出沪深合计", async () => {
    trendStub(7793e8, 8966e8);
    const m = await fetchMarketAmount(
      quotesOf({ "1.000001": 6625e8, "0.399001": 7519e8, "0.899050": 122e8 }),
      "tencent",
    );
    expect(m.total).toBe(6625e8 + 7519e8 + 122e8);
    expect(m.hsTotal).toBe(6625e8 + 7519e8);
  });

  it("缺一个市场就不冒充「全市场」，退回 null", async () => {
    trendStub(7793e8, 8966e8);
    const m = await fetchMarketAmount(
      quotesOf({ "1.000001": 6625e8, "0.399001": 7519e8, "0.899050": null }),
      "tencent",
    );
    // 北证50 的成交额取不到时，total 不能只算沪深就叫做全市场
    expect(m.total).toBeNull();
    expect(m.hsTotal).toBe(6625e8 + 7519e8);
  });

  it("上一日同期取不到时 hsPrev 为 null，不影响今日值", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    const m = await fetchMarketAmount(
      quotesOf({ "1.000001": 6625e8, "0.399001": 7519e8, "0.899050": 122e8 }),
      "tencent",
    );
    expect(m.hsPrev).toBeNull();
    expect(m.total).toBe(6625e8 + 7519e8 + 122e8);
  });
});

describe("腾讯成交额单位", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** 造一行腾讯报价：f[37] 是成交额字段 */
  const tx = (code: string, name: string, amt: string) => {
    const p = new Array(38).fill("");
    p[2] = code.slice(2); p[3] = "10"; p[30] = "20261014120535"; p[37] = amt;
    return new TextEncoder().encode(`v_${code}="1~${name}~` + p.slice(2).join("~") + `";`);
  };

  it("A 股的 f[37] 是万元，换算成元", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(tx("sh000001", "SH", "66249184"))));
    const got = await fetchQuotes(["1.000001"], "tencent");
    expect(got.get("1.000001")?.amount).toBe(66249184 * 1e4);
  });

  it("港股/美股的 f[37] 量纲对不上，一律给 null 而不是错值", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(tx("hk00700", "HK", "6469119686.486"))));
    const got = await fetchQuotes(["116.00700"], "tencent");
    expect(got.get("116.00700")?.amount).toBeNull();
  });
});

describe("板块列表：两套数据源", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** 东财 clist 的一页 */
  const emPage = (rows: unknown[], total: number) =>
    new Response(JSON.stringify({ data: { total, diff: rows } }));
  const emRow = (
    code: string,
    name: string,
    pct: number,
    leader: string | null = "晨曦航空",
    leaderPct: number | string | null = 20.02,
  ) => ({
    f2: 50520.08,
    f3: pct,
    f12: code,
    f13: 90,
    f14: name,
    f128: leader,
    f136: leaderPct,
  });

  /** 腾讯排行的一页 */
  const txPage = (rows: unknown[]) =>
    new Response(JSON.stringify({ code: 0, data: { rank_list: rows } }));
  const txRow = (code: string, name: string, zdf: string, leader = "金达威", leaderPct = "10.03") => ({
    code,
    name,
    zdf,
    zxj: "13938.75",
    lzg: { name: leader, zdf: leaderPct },
  });

  it("东财：secid 带 90. 前缀、按 total 翻页、领涨股为 '-' 时给 null", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(u);
        return u.includes("pn=1")
          ? emPage([emRow("BK0480", "航天航空", 5.4)], 101)
          : emPage([emRow("BK1305", "燃料电池", -2.2, "-", "-")], 101);
      }),
    );
    const got = await fetchBoards("industry", "eastmoney");

    expect(urls).toHaveLength(2);
    expect(got.map((b) => b.secid)).toEqual(["90.BK0480", "90.BK1305"]);
    expect(got[0]).toMatchObject({ name: "航天航空", pct: 5.4, leader: "晨曦航空", leaderPct: 20.02 });
    expect(got[1]).toMatchObject({ leader: null, leaderPct: null });
  });

  it("腾讯：行业默认只拉一级 hy，开关打开才追加 hy2", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(u);
        return u.includes("board_type=hy&")
          ? txPage([txRow("pt01801120", "食品饮料", "0.66")])
          : txPage([txRow("pt01801121", "白酒Ⅱ", "1.28")]);
      }),
    );

    const base = await fetchBoards("industry", "tencent");
    expect(urls).toHaveLength(1);
    expect(base.map((b) => b.secid)).toEqual(["91.pt01801120"]);

    urls.length = 0;
    const withSubs = await fetchBoards("industry", "tencent", true);
    expect(urls).toHaveLength(2);
    expect(withSubs.map((b) => b.secid)).toEqual(["91.pt01801120", "91.pt01801121"]);
    expect(withSubs[0]).toMatchObject({ name: "食品饮料", pct: 0.66, leader: "金达威", leaderPct: 10.03 });
  });
  it("腾讯：满页就继续翻，最后一页不满就停", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(u);
        const off = Number(new URL(u).searchParams.get("offset"));
        const n = off === 0 ? 200 : 3;
        return txPage(Array.from({ length: n }, (_, i) => txRow(`pt${off + i}`, `板块${off + i}`, "1.00")));
      }),
    );

    const got = await fetchBoards("concept", "tencent");

    expect(urls).toHaveLength(2);
    expect(got).toHaveLength(203);
  });

  it("auto：东财不通时自动退腾讯", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(u);
        if (u.includes("push2.eastmoney.com")) {
          // 连探活（根路径）都不通：整条链路失联
          return new Response("", { status: new URL(u).pathname === "/" ? 404 : 502 });
        }
        return txPage([txRow("pt01801120", "食品饮料", "0.66")]);
      }),
    );

    const got = await fetchBoards("industry", "auto");

    expect(got[0].secid).toBe("91.pt01801120");
    expect(urls.some((u) => u.includes("push2.eastmoney.com"))).toBe(true);
    expect(urls.some((u) => u.includes("proxy.finance.qq.com"))).toBe(true);
  });

  it("source=tencent 只打腾讯，一次都不碰东财", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(u);
        return txPage([txRow("pt01801120", "食品饮料", "0.66")]);
      }),
    );

    await fetchBoards("concept", "tencent");

    expect(urls.every((u) => !u.includes("eastmoney.com"))).toBe(true);
  });

  it("两家都失败时抛出，不返回半份榜单", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    await expect(fetchBoards("industry", "auto")).rejects.toThrow(ApiError);
  });
});

describe("板块 secid 的来源", () => {
  it("90. 是东财的、91. 是腾讯的，其余不算板块", () => {
    expect(boardSourceOf("90.BK0480")).toBe("eastmoney");
    expect(boardSourceOf("91.pt01801120")).toBe("tencent");
    expect(boardSourceOf("1.600519")).toBeNull();
    expect(isBoardSecid("90.BK0480")).toBe(true);
    expect(isBoardSecid("91.pt01801120")).toBe(true);
    expect(isBoardSecid("1.600519")).toBe(false);
  });

  it("腾讯板块的代码就是腾讯代码，直接拿去报价 / 分时", () => {
    expect(tencentCode("91.pt01801120")).toBe("pt01801120");
  });
});

describe("腾讯板块分时（只有 3 列）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("按「时间 价格 累计量」解析：没有成交额、也没有均价线", async () => {
    const body = {
      code: 0,
      data: {
        pt01801120: {
          data: [{ data: ["0930 13807.76 772021.0", "0931 13829.21 1109572.0"], date: "20261016", prec: "13847.83" }],
          qt: { pt01801120: ["2", "食品饮料", "01801120", "13938.75", "13847.83"] },
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));

    const got = await fetchTrend("91.pt01801120", 1, "tencent");

    expect(got.name).toBe("食品饮料");
    expect(got.preClose).toBe(13847.83);
    expect(got.points.map((p) => [p.time, p.price])).toEqual([
      ["0930", 13807.76],
      ["0931", 13829.21],
    ]);
    expect(got.points.every((p) => p.amount === null && p.avg === null)).toBe(true);
  });
});

// 腾讯板块排行在应用里由 Rust 侧代取（这条接口不返回 CORS 头，webview 里 fetch 一定被拦，
// 见 src/api.ts 的 boardsPageTencent）。这里用假的 __TAURI_INTERNALS__ 把命令接线跑通：
// 传的是哪几个参数、回来的 JSON 怎么变成 Board。
describe("腾讯板块排行：应用里走 Rust 侧", () => {
  const rankBody = (rows: unknown[]) =>
    JSON.stringify({ code: 0, msg: "ok", data: { rank_list: rows } });
  const oneRow = { code: "pt01801120", name: "食品饮料", zdf: "0.84", zxj: "13964.02", lzg: { name: "金达威", zdf: "7.39" } };

  let calls: { cmd: string; args: Record<string, unknown> }[];
  /** 命令的实现：每个用例自己定（回什么 / 抛什么） */
  let reply: () => Promise<unknown>;

  beforeEach(() => {
    calls = [];
    vi.resetModules();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return reply();
      },
    };
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
  });

  it("走命令而不是 fetch：参数是口径与偏移，回来的一行照常变成 Board", async () => {
    reply = async () => rankBody([oneRow]);
    const fetchMock = vi.fn(async (_u: string) => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchBoards } = await import("./api");

    const got = await fetchBoards("industry", "tencent");

    expect(calls).toEqual([{ cmd: "qq_board_rank", args: { ftype: "hy", offset: 0 } }]);
    expect(got[0]).toMatchObject({
      secid: "91.pt01801120",
      code: "pt01801120",
      name: "食品饮料",
      pct: 0.84,
      price: 13964.02,
      leader: "金达威",
      leaderPct: 7.39,
    });
    // 那条接口没有 CORS 头：应用里一次都不该再直连它
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("proxy.finance.qq.com"))).toBe(false);
  });

  it("「细分」开着时行业多拉一段 hy2，两段各自按整页偏移翻页", async () => {
    reply = async () => rankBody([oneRow]);
    const { fetchBoards } = await import("./api");

    await fetchBoards("industry", "tencent", true);

    expect(calls.map((c) => c.args)).toEqual([
      { ftype: "hy", offset: 0 },
      { ftype: "hy2", offset: 0 },
    ]);
  });

  it("命令失败（连不上 / 非 200）算源站故障：抛 ApiError，不返回半份榜单", async () => {
    reply = async () => {
      throw "板块接口连不上：连接失败";
    };
    const api = await import("./api");

    await expect(api.fetchBoards("concept", "tencent")).rejects.toThrow(api.ApiError);
  });

  it("auto：东财那侧仍然走 fetch，只有腾讯这侧换成命令", async () => {
    reply = async () => rankBody([oneRow]);
    const fetchMock = vi.fn(async (_u: string) => new Response("", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchBoards } = await import("./api");

    const got = await fetchBoards("industry", "auto");
    expect(got[0].secid).toBe("91.pt01801120");
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes("proxy.finance.qq.com"))).toBe(true);
    expect(calls.length).toBe(1); // 东财失败后这一页才有腾讯那一次
  });
});
