/* 自动生成, 请勿手改 —— 由 scripts/build-text-plugin.ts 从 runtime.mjs + zh_tw/dict.json 生成 */
/* 作用: 把英雄联盟**客户端界面**的中文替换成目标语言。只改客户端页面里的文字, */
/*       不涉及任何文件, 也不涉及局内游戏(局内是另一个进程, 本插件碰不到)。 */
(() => {
/**
 * 客户端界面文字替换核心(运行在英雄联盟客户端页面里)。
 *
 * 设计约束:
 * - 只用浏览器标准接口(MutationObserver / requestAnimationFrame / localStorage / clipboard),
 *   不依赖任何加载器的私有 API, 所以换成别的加载器也能用。
 * - 整个能力集中在这一个自包含函数里(不引用外部变量), 打包时直接把它转成字符串塞进插件,
 *   因此这里改成任何东西都不需要改打包脚本。
 * - 任何异常都必须自我禁用: 最坏情况是"没翻译", 绝不能把客户端界面搞卡死。
 */

/** 含中日韩文字才算"需要翻译"的原文。 */
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** 这些标签里的文字绝不动。 */
const SKIP_TAGS = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "SVG", "CANVAS", "IFRAME", "TITLE", "HEAD"];

/** 默认不动的区域: 输入框、可编辑区(聊天框、昵称编辑等)。 */
const DEFAULT_SKIP_SELECTORS = ["[contenteditable='true']", "[contenteditable='']", "input", "textarea", "select"];

/**
 * 把一段文字翻译成目标语言。
 * 返回 null 表示"没有对应译文, 保持原样"。
 * 前后空白原样保留, 只有中间的主体参与查表 —— 界面文字常带缩进和换行。
 */
function translate(text, dict, patterns) {
  if (typeof text !== "string" || text.length === 0) return null;
  const leading = text.match(/^\s*/)[0];
  const trailing = text.match(/\s*$/)[0];
  const core = text.slice(leading.length, text.length - trailing.length);
  if (!core || !CJK.test(core)) return null;
  const direct = Object.prototype.hasOwnProperty.call(dict, core) ? dict[core] : undefined;
  if (typeof direct === "string" && direct.length > 0) return leading + direct + trailing;
  if (patterns) {
    for (let i = 0; i < patterns.length; i += 1) {
      const [re, to] = patterns[i];
      if (re.test(core)) return leading + core.replace(re, to) + trailing;
    }
  }
  return null;
}

/** 是否值得记录进"待翻译清单"(含中文、长度适中、还没有译文)。 */
function isCollectable(text, dict, maxLength) {
  if (typeof text !== "string") return false;
  const core = text.trim();
  if (!core || core.length > maxLength) return false;
  if (!CJK.test(core)) return false;
  return !Object.prototype.hasOwnProperty.call(dict, core);
}

/**
 * 安装文字替换器。返回一个控制器(可 off/on/dump/stats), 出任何问题都自动禁用自己。
 * options: { dict, patterns, collect, maxLength, skipSelectors, storageKey, debug }
 */
function createTextReplacer(options) {
  const opts = options || {};
  const dict = opts.dict || {};
  const patterns = opts.patterns || [];
  const collect = opts.collect !== false;
  const maxLength = typeof opts.maxLength === "number" ? opts.maxLength : 40;
  const skipSelectors = opts.skipSelectors || ["[contenteditable='true']", "input", "textarea"];
  const storageKey = opts.storageKey || "__tr_collected";
  const SKIP_TAGS = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "SVG", "CANVAS", "IFRAME", "TITLE", "HEAD"];
  const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
  const state = { on: true, replaced: 0, scanned: 0, failed: 0, error: "" };
  const written = new WeakMap();
  const pending = new Set();
  const collected = new Set();
  let scheduled = false;

  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved) for (const item of JSON.parse(saved)) collected.add(item);
  } catch (error) { /* 存储不可用不影响替换 */ }

  function saveCollection() {
    try { window.localStorage.setItem(storageKey, JSON.stringify([...collected])); } catch (error) { /* 忽略 */ }
  }

  function shouldSkip(element) {
    let node = element;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 40) {
      const tag = node.tagName;
      if (tag && SKIP_TAGS.indexOf(tag) >= 0) return true;
      if (tag === "BODY" || tag === "HTML") return false;
      for (let i = 0; i < skipSelectors.length; i += 1) {
        try { if (node.matches && node.matches(skipSelectors[i])) return true; } catch (error) { /* 选择器不合法就忽略 */ }
      }
      node = node.parentElement;
      depth += 1;
    }
    return false;
  }

  function handleTextNode(node) {
    const value = node.nodeValue;
    if (typeof value !== "string" || value.length === 0) return;
    if (written.get(node) === value) return;            // 是我们自己刚写的, 不要再动
    state.scanned += 1;
    const parent = node.parentElement;
    if (parent && shouldSkip(parent)) return;
    const result = translate(value, dict, patterns);
    if (result !== null) {
      if (result === value) return;
      written.set(node, result);
      try { node.nodeValue = result; state.replaced += 1; } catch (error) { state.failed += 1; }
      return;
    }
    if (collect) {
      const core = value.trim();
      if (core.length > 0 && core.length <= maxLength && CJK.test(core) && !collected.has(core)) {
        collected.add(core);
        saveCollection();
      }
    }
  }

  /** 手动深度优先遍历(不用 TreeWalker, 因为要能递归进 shadow root, 也好测试)。 */
  function walk(root, depth) {
    if (!state.on || !root || depth > 60) return;
    const children = root.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (child.nodeType === 3) handleTextNode(child);
        else if (child.nodeType === 1) {
          if (child.shadowRoot) { observe(child.shadowRoot); walk(child.shadowRoot, depth + 1); }
          walk(child, depth + 1);
        }
      }
    }
    if (root.shadowRoot && root.nodeType === 1) { observe(root.shadowRoot); walk(root.shadowRoot, depth + 1); }
  }

  function flush() {
    scheduled = false;
    if (!state.on) return;
    if (state.error) return;
    const queue = [...pending];
    pending.clear();
    try {
      for (const node of queue) {
        if (!node.isConnected) continue;
        if (node.nodeType === 3) handleTextNode(node);
        else walk(node, 0);
      }
    } catch (error) {
      state.error = String((error && error.message) || error);
      state.on = false;                                  // 自我禁用, 绝不影响客户端
      try { console.error("[text-replacer] 出错已自动停用:", error); } catch (e) { /* 忽略 */ }
    }
  }

  function schedule(node) {
    if (!state.on || state.error) return;
    pending.add(node);
    if (pending.size > 4000) pending.clear();            // 极端情况下宁可漏也不卡
    if (scheduled) return;
    scheduled = true;
    try { window.requestAnimationFrame(flush); } catch (error) { flush(); }
  }

  const observed = new WeakSet();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") schedule(record.target);
      else for (const node of record.addedNodes) schedule(node);
    }
  });

  function observe(root) {
    if (!root || observed.has(root)) return;
    try {
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      observed.add(root);
    } catch (error) { /* 观察失败不影响已处理的部分 */ }
  }

  // 新挂上来的 shadow root 也要被观察到(客户端大量使用组件)
  try {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = original.call(this, init);
      try { observe(root); schedule(root); } catch (error) { /* 忽略 */ }
      return root;
    };
  } catch (error) { /* 忽略 */ }

  observe(document.documentElement);
  walk(document.body || document.documentElement, 0);

  const controller = {
    get on() { return state.on; },
    off() { state.on = false; return "off"; },
    on_() { state.on = true; state.error = ""; walk(document.body || document.documentElement, 0); return "on"; },
    stats() { return { replaced: state.replaced, scanned: state.scanned, failed: state.failed, error: state.error, collected: collected.size }; },
    /** 导出"没翻译到"的中文清单(按出现次数无从统计, 按长度排序)。 */
    dump() {
      const list = [...collected].sort();
      const text = JSON.stringify(list, null, 2);
      try { navigator.clipboard.writeText(text); } catch (error) { /* 忽略 */ }
      return list;
    },
    clear() { collected.clear(); saveCollection(); return "cleared"; },
    translate
  };
  return controller;
}
  const dict = {"护甲":"物理防禦","攻击速度":"攻速","格挡":"封鎖","暴击几率":"暴擊機率","暴击伤害":"暴擊傷害","能量回复/5秒":"能量回復／5 秒。","经验值":"經驗值","生命值":"生命","生命回复/5秒":"生命回復／5 秒。","法术强度":"魔法攻擊","移动速度":"跑速","法力":"魔力","法力回复/5秒":"魔力回復／5 秒。","攻击力":"物理攻擊","魔法抗性":"魔法防禦","闪避":"閃避","经验获取":"獲得經驗值","生命回复":"生命回復","生命偷取":"普攻吸血","法力回复":"魔力回復","法术吸血":"技能吸血","护甲于18级":"物理防禦（18級）","护甲穿透":"物理致命","护甲穿透于18级":"物理致命（18級）","暴击几率于18级":"暴擊機率（18級）","暴击伤害于18级":"暴擊傷害（18級）","闪避于18级":"閃避（18級）","能量于18级":"能量（18級）","能量回复于18级":"能量回復（18級）","金/10秒":"金錢／10 秒。","生命值于18级":"生命（18級）","生命回复于18级":"生命回復（18級）","法术强度于18级":"魔法攻擊（18級）","法术穿透":"魔法穿透","法术穿透于18级":"物理穿透（18級）","移动速度于18级":"跑速（18級）","法力于18级":"魔力（18級）","法力回复于18级":"魔力回復（18級）","攻击力于18级":"物理攻擊（18級）","魔法抗性于18级":"魔法防禦（18級）","死亡时间":"死亡時間","死亡时间于18级":"死亡時間（18級）","攻击速度于18级":"攻擊速度（18級）","冷却缩减":"冷卻時間減免","冷却缩减于18级":"冷卻時間減免（18級）","穿甲":"物理致命","穿甲于18级":"物理致命（18級）","正在更新《英雄联盟》……":"正在更新英雄聯盟 ...",";annie;安妮;黑暗之女;heianzhinv;huonv;火女;an;hazn;hn":";annie;安妮",";kayle;kaier;凯尔;tianshi;天使;审判;ke;ts;shenpan;spts":";kayle;凱爾",";xerath;zelasi;泽拉斯;tesila;特斯拉;yuanguwuling;远古巫灵;zls;tsl;ygwl":";xerath;齊勒斯",";shyvana;龙女;longnv;xiwana;希瓦娜;龙血武姬;longxuewuji;ln;xwn;lxwj":";shyvana;希瓦娜",";ahri;ali;阿狸;huli;狐狸;九尾妖狐;jiuweiyaohu;hl;jwyh":";ahri;阿璃",";graves;格雷福斯;geleifusi;法外狂徒;fawaikuangtu;nanqiang;男枪;nq;glfs;fwkt":";graves;葛雷夫",";fizz;feizi;chaoxihailing;菲兹;潮汐海灵;xiaoyuren;小鱼人;fz;cxhl;xyr":";fizz;飛斯",";volibear;gouxiong;狗熊;wolibeier;沃利贝尔;不灭狂雷;bumiekuanglei;gx;wlbe;bmkl":";volibear;弗力貝爾",";rengar;shizigou;狮子狗;leienjiaer;雷恩加尔;aozhizhuiliezhe;傲之追猎者;szg;leje;azzlz":";rengar;雷葛爾",";master yi;yidashi;易大师;jiansheng;剑圣;wuji;无极;yds;js;wjjs;yi":";master yi;易大師",";varus;weilusi;韦鲁斯;chengjiezhijian;惩戒之箭;wls;cjzj":";varus;法洛士",";nautilus;taitan;泰坦;nuotilesi;诺提勒斯;shenhai;深海;ntls;sstt;tt":";nautilus;納帝魯斯",";viktor;weiketuo;维克托;jixiexianqu;机械先驱;三只手;sanzhishou;szs;wkt;jxxq;aoshuxianqu;asxq;奥术先驱":";viktor;維克特",";sejuani;zhunv;zhumei;猪女;猪妹;sezhuangni;瑟庄妮;beidizhinu;北地之怒;szn;zn;zm;bdzn":";sejuani;史瓦妮",";fiora;剑姬;jianji;feiaona;菲奥娜;wushuang;无双;fan;fon;jj;wsjj":";fiora;菲歐拉",";ziggs;zhadanren;炸弹人;吉格斯;jigesi;guicai;鬼才;baopo;爆破;jgs;bpgc;gc;zdr":";ziggs;希格斯",";lulu;璐璐;露露;仙灵女巫;xianlingnvwu;ll;xlnw":";lulu;露璐",";draven;德莱文;delaiwen;文森特;wensente;rongyaoxingxingguan;荣耀行刑官;dlw;wst;ryxxg":";draven;達瑞文",";alistar;niutou;牛头;alisita;阿利斯塔;nt;alst":";alistar;亞歷斯塔",";hecarim;hekalimu;赫卡里姆;renma;人马;zhanzhengzhiying;战争之影;hklm;rm;zzzy":";hecarim;赫克林",";kha'zix;tanglang;螳螂;kazike;卡兹克;xukong;虚空;tl;kzk;xk":";kha'zix;卡力斯",";darius;delaiesi;德莱厄斯;nuoshou;诺手;dles;ns;诺克萨斯之手;nuokesasizhishou;nksszs":";darius;達瑞斯",";jayce;jiesi;杰斯;weilaishouhuzhe;未来守护者;js;wlshz":";jayce;杰西",";lissandra;bingnv;冰女;lisangzhuo;丽桑卓;bingshuangnvwu;冰霜女巫;bn;lsz;bsnw":";lissandra;麗珊卓",";ryze;faker;liulang;流浪;瑞兹;ruizi;fuwenfashi;符文法师;guangtou;光头;rz;ll;fwfs;gt":";ryze;雷茲",";diana;daianna;黛安娜;jiaoyue;皎月女神;戴安娜;dan;jyns;jy":";diana;黛安娜",";quinn;kuiyin;奎因;niaoren;鸟人;demaxiyazhiyi;德玛西亚之翼;ky;dmxyzy":";quinn;葵恩",";syndra;qiunv;球女;xindela;辛德拉;anheiyuanshou;暗黑元首;qn;xdl;ahys":";syndra;星朵拉",";aurelion sol;龙王;奥瑞利安;索尔;zhuxing;longwang;铸星;aoruilian;arla;lw;zxlw":";aurelion sol;翱銳龍獸",";sion;saien;赛恩;wanglingzhanshen;亡灵战神;se;wlzs":";sion;賽恩",";凯隐;kaiyin;kayn;暗裔魔镰;anyimolian;yingliuzhilian;影流之镰;ky;ayml;ylzl":";Kayn;慨影;慨;影",";zoe;zuoyi;佐伊;muguangxingling;暮光星灵;zy;mgxl;":";zoe;柔依",";zyra;jiela;婕拉;jingjizhixing;荆棘之兴;jl;jjzx":";zyra;枷蘿",";kai'sa;kasha;xukong;虚空;卡莎;ks;xkzn":";kai'sa;凱莎",";Seraphine;salefenni;geji;slfn;xlgj;gj;萨勒芬妮;星籁;歌姬;酸辣粉;suanlafen":";Seraphine;瑟菈紛",";qiyana;qyn;ysnh;yuansunvhuang;奇亚娜;元素女皇;圈子妈;quanzima":";qiyana;姬亞娜",";sivir;xiweier;希维尔;lunzima;轮子妈;zhanzhengnvshen;战争女神;xwe;lzm;zzns":";sivir;希維爾",";gnar;naer;纳尔;mishizhiya;迷失之牙;ne;mszy":";gnar;吶兒",";zac;zhake;扎克;shenghuamoren;生化魔人;zk;shmr":";zac;札克",";yasuo;kuaile;fengnan;快乐;风男;亚索;jianhao;剑豪;jifeng;疾风;ys;jfjh;klfn":";yasuo;犽宿",";soraka;naima;奶妈;索拉卡;suolaka;slk;nm;星妈;xingma;xm":";soraka;索拉卡",";vel'koz;大眼;dayan;weikezi;维克兹;xukong;虚空;dy;wkz;xkzy":";vel'koz;威寇茲",";taliyah;taliya;塔利亚;塔莉垭;yanque;岩雀;tly;yq":";taliyah;塔莉雅",";camille;青钢影;卡蜜尔;qinggangying;kamier;qgy;kme":";camille;卡蜜兒",";akshan;阿克尚;影哨;the Rogue Sentinel;aks;akeshang;yingshao;ys":";akshan;埃可尚",";teemo;timo;提莫;tibaiwan;提百万;xunjiechihou;迅捷斥候;tm;xjch":";teemo;提摩",";tristana;xiaopao;小炮;paoniang;炮娘;崔丝塔娜;cuisitana;mailinpaoshou;麦林炮手;xp;cstn;mlps":";tristana;崔絲塔娜",";warwick;langren;狼人;wolike;沃里克;祖安怒兽;zuan;wlk;lr;zans":";warwick;沃維克",";olaf;aolafu;奥拉夫;kuangzhanshi;狂战士;alf;kzs":";olaf;歐拉夫",";nunu;努努;xueren;雪人;xueyuanshuangzi;雪原双子;xr;xysz;nn":";nunu;努努",";belveth;beierweisi;xukongnvhuang;brws;xknh;Void Empress;卑尔维斯;虚空;女皇;虚空女皇;nvhuang;nh":";belveth;貝爾薇斯",";braum;bulong;布隆;fuleierzhuode;弗雷尔卓德;bl;flezd":";braum;布郎姆",";jhin;烬;戏命师;jin;wangyuan;望远;ximingshi;xms;wyj":";jhin;燼",";kindred;qianjue;千珏;yonglieshuangzi;永猎双子;qj;ylsz":";kindred;鏡爪",";miss fortune;nvqiang;女枪;mf;eyunxiaojie;厄运小姐;haoyunjie;好运姐;shangjin;赏金;nq;eyxj;sj;hyj":";miss fortune;好運姐",";ashe;aishe;爱射;aixi;艾希;hanbing;寒冰;as;ax;hb":";ashe;艾希",";zeli;zeri;zuanhuahuo;zahh;泽丽;zl;祖安花火":";zeri;婕莉",";jinx;jinkesi;金克丝;baozou;luoli;暴走;萝莉;jks;bzll;powder;baobao;bb;爆爆":";jinx;吉茵珂絲",";tahm kench;hama;蛤蟆;tamu;塔姆;hm;tm;河流之王;hlzw;heliuzhiwang":";tahm kench;貪啃奇",";tryndamere;manwang;蛮王;taidamier;泰达米尔;mw;tdme":";tryndamere;泰達米爾",";briar;the Restrained Hunger;贝蕾亚;狂厄蔷薇;bly;keqw;beileiya;kuangeqiangwei":";briar;布蕾爾",";viego;Ruined King;佛耶戈;破败之王;v哥;foyege;fyg;pobaizhiwang;pbzw;破败王;pobaiwang;pbw":";viego;維爾戈",";saina;senna;赛娜;dihunshengqiang;涤魂圣枪;sn;dhsq":";senna;姍娜",";lucian;aobama;奥巴马;luxian;卢锡安;shengqiangyouxia;圣枪游侠;abm;lxa;sqyx":";lucian;路西恩",";zed;jie;劫;yingliuzhizhu;影流之主;ylzz":";zed;劫",";jax;jiakesi;贾克斯;wuqidashi;武器大师;jks;wqds;武器":";jax;賈克斯",";kled;克烈;暴怒骑士;kelie;baonuqishi;kl;bnqs":";Kled;克雷德",";ekko;aike;艾克;时间刺客;shijiancike;ak;sjck":";ekko;艾克",";morgana;moganna;莫甘娜;duoluotianshi;堕落天使;mgn;dlts":";morgana;魔甘娜",";vi;wei;蔚;pichengzhifaguan;皮城执法官;pczfg;violet;蔚奥莱;weiaolai;wal;楚雨荨;chuyuxun;cyx":";vi;菲艾",";zilean;shiguang;laotou;时光;老头;jilan;基兰;sg;jl":";zilean;極靈",";aatrox;yatuokesi;亚托克斯;jianmo;剑魔;anyi;暗裔;ytks;jm;ayjm":";aatrox;厄薩斯",";nami;namei;娜美;huanchaojiaoji;唤潮鲛姬;nm;hcjj":";nami;娜米",";azir;shahuang;沙皇;azier;阿兹尔;shamohuangdi;沙漠皇帝;sh;aze;smhd":";azir;阿祈爾",";singed;lianjin;炼金;xinjide;辛吉德;lj;xjd":";singed;辛吉德",";evelynn;guafu;寡妇;yifulin;伊芙琳;tongkuzhiyong;痛苦之拥;gf;yfl;tkzy":";evelynn;伊芙琳",";twitch;laoshu;老鼠;tuqi;图奇;wenyizhiyuan;瘟疫之源;ls;tq;wyzy":";twitch;圖奇",";galio;jialiao;加里奥;zhengyijuxiang;正义巨像;jla;jlo;zyjx":";galio;加里歐",";karthus;sige;死歌;kaersasi;卡尔萨斯;sg;kess":";karthus;卡爾瑟斯",";cho'gath;kejiasi;科加斯;dachongzi;大虫子;xukong;虚空恐惧;kjs;dcz;xkkj":";cho'gath;科加斯",";amumu;阿木木;munaiyi;木乃伊;amm;mny":";amumu;阿姆姆",";rammus;longgui;wangba;龙龟;王八;lamosi;拉莫斯;lms;lg;wb":";rammus;拉姆斯",";anivia;bingniao;冰鸟;fenghuang;凤凰;ainiweiya;艾尼维亚;bn;fh;anwy":";anivia;艾妮維亞",";shaco;xiaochou;小丑;sake;萨科;xc;sk":";shaco;薩科",";youmi;yuumi;maomi;cat;mfmm;魔法猫咪;猫咪;魔法;悠米;ym;mm":";yuumi;悠咪",";dr. mundo;mengduo;蒙多;zuan;祖安狂人;md;zakr":";dr. mundo;蒙多醫生",";samira;沙漠玫瑰;莎弥拉;shamila;desert rose;samila;shamomeigui;萨米拉;sml;smmg":";samira;煞蜜拉",";sona;qinnv;琴女;suona;娑娜;qinsexiannv;琴瑟仙女;sn;qn;qsxn":";sona;索娜",";kassadin;kasading;卡萨丁;xukong;虚空行者;xkxz;xukongxingzhe;ksd":";kassadin;卡薩丁",";irelia;daomei;刀妹;airuiliya;艾瑞丽娅;daofengwuzhe;刀锋舞者;dm;arly;dfwz;女刀;nd;nvdao":";irelia;伊瑞莉雅",";twisted fate;tf;kapai;卡牌大师;cuisite;崔斯特;kp;kpds;kapaidashi;cst":";twisted fate;逆命",";janna;998;fengnv;风女;jiana;迦娜;fengbaozhinu;风暴之怒;fn;jn;fbzn":";janna;珍娜",";gangplank;chuanzhang;船长;pulangke;普朗克;haiyangzhizai;海洋之灾;cz;plk;hyzz":";gangplank;剛普朗克",";thresh;chuishi;锤石;hunsuodianyuzhang;魂锁典狱长;cs;hsdyz":";thresh;瑟雷西",";corki;feiji;飞机;kuqi;库奇;yingyongtoudanshou;英勇投弹手;fj;kq;yytds":";corki;庫奇",";illaoi;eluoyi;俄洛伊;haishoujisi;海兽祭司;chushouma;触手妈;大妈;dama;ely;hsjs;csm;dm":";illaoi;伊羅旖",";rek'sai;leikesai;雷克塞;挖掘机;wajueji;xukongdundishou;虚空;lks;wjj;xkdds":";rek'sai;雷珂煞",";ivern;艾翁;翠神;aiweng;cuishen;xiaoju;小菊;aw;cs;xj;xiaoshu;xs;小树":";Ivern;埃爾文",";kalista;huabanxie;滑板鞋;kalisita;卡莉丝塔;fuchouzhimao;复仇之矛;hbx;klst;fczm":";kalista;克黎思妲",";karma;shanzima;扇子妈;kaerma;卡尔玛;tianqizhe;天启者;kem;szm;tqz":";karma;卡瑪",";bard;bade;巴德;yinyoushiren;吟游诗人;xingjieyoushen;星界游神;bd;yysr;xjys":";bard;巴德",";taric;baoshi;宝石;talike;塔里克;waluolanzhidun;瓦洛兰之盾;tlk;bs;wllzd":";taric;塔里克",";veigar;weijia;维迦;xieexiaofashi;邪恶小法师;wj;xiaofashi;小法师;xfs;xexfs;小法":";veigar;維迦",";trundle;jumo;巨魔;telangdeer;特朗德尔;tlde;jm":";trundle;特朗德",";rakan;洛;幻翎;luo;huanling;fenghuangchuanqi;凤凰传奇;hl;fhcq":";rakan;銳空",";xayah;霞;逆羽;xia;niyu;fenghuangchuanqi;凤凰传奇;fhcq;ny":";xayah;剎雅",";xin zhao;zhaoxin;赵信;xinye;信爷;zx;xy;debangzongguan;德邦总管;dbzg":";xin zhao;趙信",";swain;wuya;乌鸦;siweiyin;斯维因;nuokesasitongling;诺克萨斯统领;wy;swy;nksstl":";swain;斯溫",";caitlyn;nvjing;女警;kaitelin;凯特琳;picheng;皮城;nj;ktl;pcnj;cupcake;xiaodangao;xdg;小蛋糕":";caitlyn;凱特琳",";ornn;奥恩;山隐之焰;aoen;shanyinzhiyan;ae;syzy;yang;羊":";ornn;鄂爾",";解脱者;sailasi;sls;jtz;jietuozhe;sylas;Unshackled;塞拉斯":";賽勒斯;sylas",";nikou;neeko;wanhua;whtl;nk;妮蔻;万花通灵":";neeko;妮可",";efeiliusi;aphelios;the Weapon of Faith;canyuezhisu;厄斐琉斯;残月之肃;无E烦;wuefan;wuyifan;月男;yuenan;efls;cyzs;yn;wyf":";aphelios;亞菲利歐",";rell;ruier;芮尔;铁女;Iron Maiden;镕铁少女;re;rongtieshaonv;rtsn;tienv;tn;mamei;mm;马妹":";rell;銳兒",";blitzcrank;jiqiren;机器人;bulici;布里茨;jqr;blc;zhengqi;蒸汽;zqjqr":";blitzcrank;布里茨",";malphite;shitouren;石头人;mofeite;墨菲特;rongyanjushou;熔岩巨兽;str;mft;ryjs;ry":";malphite;墨菲特",";katarina;katelinna;卡特琳娜;buxiangzhiren;不祥之刃;卡特;kate;ktln;kt;bxzr":";katarina;卡特蓮娜",";pyke;paike;派克;xuegangguiying;血港鬼影;pk;xggy":";pyke;派克",";nocturne;mengyan;梦魇;moteng;魔腾;my;mt;夜曲;yequ;yq":";nocturne;夜曲",";maokai;茂凯;dashu;大树;niuqushujing;扭曲树精;mk;ds;nqsj":";maokai;茂凱",";renekton;eyu;鳄鱼;leikedun;雷克顿;huangmotufu;荒漠屠夫;lkd;hmtf":";renekton;雷尼克頓",";jarvan iv;huangzi;皇子;jiawensishi;嘉文四世;hz;jwss;dmxyhz;demaxiyahuangzi;德玛西亚皇子":";jarvan iv;嘉文四世",";urgot;pangxie;螃蟹;ejiate;厄加特;wuweizhanche;无畏战车;ejt;dpx;px;大螃蟹;wwzc":";urgot;烏爾加特",";elise;zhizhu;蜘蛛;yilisi;伊莉丝;zznh;女皇;yls":";elise;伊莉絲",";orianna;fatiao;发条;aolianna;奥莉安娜;ft;alan;魔灵;ftml":";orianna;奧莉安娜",";wukong;悟空;houzi;猴子;qitiandasheng;齐天大圣;孙悟空;swk;wk;hz;qtds;sunwukong":";wukong;悟空",";brand;huonan;火男;bulande;布兰德;fuchouyanhun;复仇焰魂;bld;hn;fcyh":";brand;布蘭德",";lee sin;xiazi;盲僧;瞎子;mangseng;liqing;李青;xz;ms;lq":";lee sin;李星",";vayne;uzi;weien;薇恩;anyelieshou;暗夜猎手;we;ayls":";vayne;汎",";rumble;lanbo;兰博;jixiegongdi;机械公敌;lb;jxgd":";rumble;藍寶",";cassiopeia;shenv;蛇女;kaxiaopeiya;卡西奥佩娅;moshezhiyong;魔蛇之拥;sn;kxopy;mszy":";cassiopeia;卡莎碧雅",";leblanc;yaoji;妖姬;lefulan;乐芙兰;yj;lfl;诡术妖姬;guishu;gsyj":";leblanc;勒布朗",";vex;gloomist;薇古丝;愁云使者;vgs;cysz;wgs;weigusi;veigusi;chouyunshizhe;aybb;aoyebobi;熬夜波比":";vex;薇可絲",";skarner;xiezi;蝎子;sikana;斯卡纳;shanggulingzhu;上古领主;xz;skn;sglz":";skarner;史加納",";heimerdinger;datou;大头;dafamingjia;大发明家;heimodingge;黑默丁格;dt;dmmj;hmdg;famingjia;fmj;发明家":";heimerdinger;漢默丁格",";nasus;goutou;狗头;neisesi;内瑟斯;shamosishen;沙漠死神;nss;gt;smss":";nasus;納瑟斯",";nidalee;naidali;奶大力;baonv;豹女;naideli;奈德丽;kuangyenvlieshou;狂野女猎手;ndl;bn;kynls":";nidalee;奈德麗",";udyr;wudier;乌迪尔;shoulingxingzhe;兽灵行者;ud;wde;slxz;xiaoyan;xy;萧炎;野区萧炎;yequxiaoyan;yqxy":";udyr;烏迪爾",";yone;永恩;封魔剑魂;yongen;fengmojianhun;fmjh;ye":";yone;犽凝",";poppy;bobi;波比;圣锤之毅;shengchuizhiyi;bb;sczy":";poppy;波比",";gragas;jiutong;酒桶;gulajiasi;古拉加斯;gljs;jt":";gragas;古拉格斯",";ambessa;anbeisa;tiexielangmu;tiexuelangmu;txlm;abs;安蓓萨;铁血狼母;狼母;langmu;lm":";ambessa;安比薩",";vladimir;xixuegui;吸血鬼;fulajimier;弗拉基米尔;xinghongshougezhe;猩红收割者;xxg;fljme;xhsgz":";vladimir;弗拉迪米爾",";pantheon;pansen;潘森;sibada;斯巴达;buquzhiqiang;不屈之枪;ps;bqzq":";pantheon;潘森",";mel;jingyingliuguang;meier;梅尔;me;镜影流光;jylg;流光镜影;liuguangjingying;lgjy":";mel;梅爾",";yunana;芸阿娜;不破之誓;the Unbroken Faith;yan;yunara;bupozhishi;bpzs":";yunara;尤娜拉",";locke;灰烬驱魔人;洛克;the Ashen Exorcist;hjqmr;huijinqumoren;luoke;lk":";locke;洛克",";ezreal;ez;yize;伊泽;tanxianjia;探险家;yz;txj;yizeruier;伊泽瑞尔;yzre":";ezreal;伊澤瑞爾",";mordekaiser;tienan;铁男;modekaisa;莫德凯撒;tiekaiminghun;铁铠冥魂;mdks;jsds;jinshudashi;金属大师;modeganqing;莫得感情;tn;mdgq;tkmh":";mordekaiser;魔鬥凱薩",";yorick;yuelike;约里克;juemu;掘墓;muhunren;牧魂人;ylk;jm;mhr":";yorick;約瑞科",";akali;阿卡丽;liqunzhici;离群之刺;akl;lqzc":";akali;阿卡莉",";kennen;kainan;凯南;dianhaozi;电耗子;kuangbaozhixin;狂暴之心;kn;kbzx":";kennen;凱能",";garen;gailun;盖伦;德玛西亚之力;demaxiyazhili;gl;dmxyzl":";garen;蓋倫",";seti;sett;the Boss;瑟提;st;腕豪;wh;wanhao;男拳;nanquan;nq":";sett;賽特",";莉莉娅;liliya;hxbl;hanxiubeilei;lillia;含羞;蓓蕾;妮马;蔻马;nima;kouma;鹿女;lunv;梦鹿;menglu;beilei;lly":";lillia;莉莉亞",";gwen;gewen;the Hallowed Seamstress;灵罗娃娃;格温;gw;llww;lingluowawa;剪子妈;jianzima;jzm;剪妹;jianmei;jm;一剪没;yijianmei;yjm;滚;gun":";gwen;關",";lienata;lnt;lianjinnanjue;ljnj;renata;chemtech;baroness;烈娜塔;炼金男爵;glsk;gelasike;戈拉斯克;glasc":";renata glasc;睿娜妲．格萊斯克",";leona;nvtan;rinv;女坦;日女;leiouna;蕾欧娜;shuguangnvshen;曙光女神;lon;rn;nt;sgns":";leona;雷歐娜",";阿萝拉;aluola;aurora;双界灵兔;shuangjielingtu;sjlt;all;兔女;tunv;tn;tuzi;tz;兔子":";aurora;歐羅拉",";nila;nilah;the Joy Unbound;尼菈;nl;不羁之悦;bujizhiyue;bjzy":";nilah;淣菈",";k'sante;kuisangti;kst;nazumangrongyao;nzmry;奎桑提;纳祖芒荣耀":";k'sante;卡桑帝",";fiddlesticks;daocaoren;稻草人;feidetike;费德提克;yuangukongju;远古恐惧;dcr;fdtk;ygkj":";fiddlesticks;費德提克",";malzahar;mazha;蚂蚱;maerzhaha;玛尔扎哈;xukongxingzhe;虚空先知;mezh;mz;xkxz":";malzahar;馬爾札哈",";simode;smolder;youlong;long;chiyan;chulong;chiyanchulong;炽;龙;炽炎雏龙;斯莫德;smd;cycl;yl;幼龙;xiaolongren;xlr;小龙人;小火龙;xiaohuolong;xhl;mabaolong;mbl;妈宝龙":";smolder;史矛德",";milio;the gentle flame;mingzhu;miliou;mlo;mz;米利欧;明烛":";milio;米里歐",";zaahen;The Unsundered;不落魔锋;亚恒;yaheng;buluomofeng;yh;blmf":";zaahen;薩亨",";talon;nandao;男刀;tailong;泰隆;daofengzhiying;刀锋之影;tl;nd;df":";talon;塔隆",";hwei;彗;hui;yihuashi;the Visionary;huajia;画家;异画师;yhs;hj;maobiren;mbr;毛笔人":";hwei;赫威",";riven;ruiwen;锐雯;fangzhuzhiren;放逐之刃;rw;fzzr":";riven;雷玟",";naafiri;the Hound of a Hundred Bites;纳亚菲利;百裂冥犬;nayafeili;nyfl;bailiemingquan;blmq;gou;狗;dog":";naafiri;娜菲芮",";kog'maw;dazui;大嘴;kegemo;克格莫;shenyuanjukou;深渊巨口;kgm;dz;shenyuanjukou;syjk":";kog'maw;寇格魔",";shen;慎;muguangzhiyan;暮光之眼;yaozi;腰子;mgzy;yz":";shen;慎",";lux;lakesi;拉克丝;guanghuinvlang;光辉女郎;lks;ghnl":";lux;拉克絲","见习刺客":"惡棍","初级刺客":"徘徊者","中级刺客":"絞喉者","高级刺客":"收割者","杀戮之影":"殺戮者","杀戮宗师":"處刑者","死神":"死亡大師","见习战士":"拳師","初级战士":"武鬥家","中级战士":"戰士","高级战士":"老兵","征服之刃":"毀滅者","征服宗师":"好戰者","战神":"高階督軍","见习法师":"創建者","初级法师":"咒術師","中级法师":"召喚師","高级法师":"賢者","织法之杖":"術士","织法宗师":"巫師","法神":"大法師","见习射手":"偵察兵","初级射手":"疾行者","中级射手":"追跡者","高级射手":"遊俠","鹰隼之眼":"征服者","射击宗师":"狙擊手","狙神":"神射手","见习辅助":"助手","初级辅助":"保護者","中级辅助":"看守者","高级辅助":"防禦者","庇护之光":"守護者","庇护宗师":"守望者","守护之神":"典獄長","见习坦克":"步兵","初级坦克":"打手","中级坦克":"保壘","高级坦克":"執法者","无畏之盾":"野蠻人","无畏宗师":"巨漢","巨神":"重裝戰士","登录失败，请重试。":"無效的使用者名稱／密碼，請再試一次。","一个意料之外的错误发生了":"發生了未預期的錯誤","所有角色定位":"所有位置","战士":"鬥士","法师":"法師","辅助":"輔助","错误代码":"錯誤代碼","我们无法加载这个页面。如果你的互联网连接没问题的话，请稍等几分钟然后重试。":"我們無法載入此頁面。如果你的網路連線一切正常，請稍候數分鐘後再試一次。","重试":"再次嘗試","{{feature}}目前已被禁用":"{{feature}} 目前無法使用","这个功能目前已被禁用":"此功能目前無法使用","暂未实装":"尚未實施","创建房间":"建立對戰","退出":"離開遊戲","对水晶之痕的简短描述。":"水晶之痕的簡短介紹","和随机选择英雄的队友一起，去摧毁敌人的水晶枢纽。":"以五名隨機英雄組成隊伍，並肩作戰打下對方的主堡吧！","正义之地最古老最威严的战场当属召唤师峡谷。几百年间无数对立的召唤师们在这片战场上延续着战斗，这片战场也因此而得名。有三条不同的道路穿越整个战场。与友军一起攻击敌人最脆弱的地方，摧毁他们的基地！":"召喚峽谷是最古老也最受尊崇的正義之地，它是一片位於弗雷爾卓德、鐵脊山脈和蛇紋石河的遙遠森林。","对扭曲丛林的简短描述。":"扭曲叢林的簡短介紹","已被禁用，并在维修中。我们对此带来的不便深表歉意。":"此地圖因維修暫時無法使用，造成困擾非常抱歉。","嚎哭深渊":"咆嘯深淵","嚎哭\n深渊":"咆嘯\n深淵","召唤师峡谷":"召喚峽谷","召唤师\n峡谷":"召喚\n峽谷","扭曲丛林":"扭曲叢林","扭曲\n丛林":"扭曲\n叢林","创建自定义游戏":"創造自訂對戰","这个模式目前已被禁用":"此模式暫時無法使用","加入自定义游戏":"加入自訂對戰","匹配模式":"一般對戰","排位赛":"積分對戰","新手教程":"教學模式","人机":"玩家vs電腦","极地大乱斗":"隨機單中","全随机（极地大乱斗）1v1":"全部隨機 （隨機單中）1 vs 1","全随机（极地大乱斗）2v2":"全部隨機 （隨機單中）2 vs 2","全随机（极地大乱斗）3v3":"全部隨機 （隨機單中）3 vs 3","全随机（极地大乱斗）5v5":"全部隨機 （隨機單中）5 vs 5","全随机（极地大乱斗）6v6":"全部隨機 （隨機單中）6 vs 6","全随机人机对战（极地大乱斗）5v5":"全部隨機 vs 電腦（隨機單中）5 vs 5","统治战场5v5":"據點攻略戰5v5","极地大乱斗5v5":"隨機單中5v5","经典模式5v5":"經典模式 5 V 5","经典模式3v3":"經典模式 3 V 3","全随机（大乱斗）":"全部隨機","内部服务器错误，请稍后重试":"伺服器內部錯誤，請稍後再重試一次。","你已经与新闻服务断开了连接。请手动重新连接。":"你已離開新聞服務。請手動重連。","经常使用":"經常使用","确认":"確定","拒绝":"拒絕","最终用户许可协议":"使用者授權協議","使用条款":"使用條款","授予邀请":"允許邀請其他召喚師","移出玩家":"踢除","提升为队长":"升為隊長","撤回邀请":"收回邀請權","通过拖动来邀请玩家。":"拖曳邀請","寻找对局":"尋找對戰","阻塞":"封鎖","邀请":"邀請好友","添加":"加入","邀请玩家":"邀請玩家","发送邀请":"發送邀請","输入玩家名称":"請輸入玩家名稱","已邀请":"已邀請","你真的想移出{{summonerName}}吗？":"你確定要踢除 {{summonerName}}？","你已被移出了组房间":"你已從組隊房間中被移除","与你的好友一起玩，你就会获得组队奖励！更多好友组队意味着更多战利品，所以快去组队吧！":"跟好友一同遊玩，就能賺取派對獎勵！越多朋友、獎勵越多，還不快來組隊！","组队奖励":"派對獎勵","与你的好友一起玩来获得蓝色精萃奖励！更多好友组队意味着更多战利品！":"跟朋友一起玩來賺取權力點回饋。越多朋友越多獎勵！","快组队吧！":"組隊！","待定":"等待","已推荐":"推薦","<span class='click-instruction'>点击以添加{{pointsAssignedOnClick}}点。</span><span class='click-instruction'>按住SHIFT键点击以添加1点。</span>":"<span class='click-instruction'>點擊以增加 {{pointsAssignedOnClick}} 點。</span><span class='click-instruction'>Shift 鍵 + 點擊以增加一點。</span>","<span class='click-instruction'>点击以添加1点。</span>":"<span class='click-instruction'>點擊以增加一點。</span>","下个点数":"下次積分","无法在服务器上创建一个天赋页。也许是因为连接问题。":"建立符文頁失敗，這可能是連線問題。","添加新的天赋页":"增加新頁面","天赋页{{number}}":"天賦頁 {{number}}","你确定想要删除该页吗？":"確定要刪除此頁嗎？","删除天赋页":"刪除此頁","编辑天赋页名称":"編輯頁面名稱","可用点数：{{number}}":"可用點數： {{number}}","重置此天赋页的点数":"重置此頁點數","重置此天赋树的点数":"重置此分支","点击这里来保存你对天赋页的所有改动。":"點擊以儲存符文頁。","由于连接失败，无法保存天赋页面。":"網路出現異常，天賦儲存失敗。","保存":"儲存","你的天赋有尚未保存的改动。你想要保存吗？":"你的天賦頁中有未儲存的改動。你要儲存嗎？","需要在<span class='mastery-type'>{{type}}</span>至少分配{{ranks}}点":"需要 {{ranks}} 點的 <span class='mastery-type'>{{type}}</span>","需要在{{prereq}}至少分配{{ranks}}点":"需要 {{ranks}} 級的 {{prereq}}","剩余{{pointsLeft}}点数":"剩餘{{pointsLeft}}點","诡诈":"狡詐","凶猛":"狂暴","坚决":"意志","诡诈系":"狡詐","凶猛系":"狂暴","坚决系":"意志","房间":"群組房間","藏品":"收藏","冠军杯赛":"Clash","电竞":"電競","主页":"大廳","经典模式":"經典模式","战利品/圣堂":"戰利品","新闻":"新聞公告","云顶之弈":"聯盟戰棋","幸运商店":"專屬商店","生涯":"個人資料","海斗第3季":"大混戰組合3","更多信息":"更多資訊","检测到必要更新":"偵測到必要的更新","你的网络连接出问题了。如果你目前还没有连接上互联网，请先连接互联网。如果你已经连上互联网了但无法连接上《英雄联盟》，请查阅我们的<a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/201752664\" target='_blank'>客服信息</a>来看看是否有可行的解决方案。":"你的連線出現錯誤。如果你目前沒有連接到網路的話，請進行連接。如果你已經連接到網路但無法連接英雄聯盟，請查看我們的<a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/201752664\" target='_blank'>客服網頁</a>來確定問題所在。","好的":"好","我们复原了一个较旧版本的《英雄联盟》。现在我们将尝试把它更新为最新版本。":"我們已將您的英雄聯盟回復到較舊的版本。現在我們會嘗試更新到最新版本。","{{megabytes}} MB / {{kilobytes_per_second}} KB/秒":"{{megabytes}} MB @ {{kilobytes_per_second}} KBps","在你安装目录下的文件权限正在阻止《英雄联盟》的安装。请按“OK”键，然后我们将尝试唤起你的操作系统的权限管理器。":"安裝目錄的檔案權限使得你無法順利安裝英雄聯盟。請點擊下方按鈕，我們將會嘗試啟動作業系統的權限管理員。","在连接至服务器时出问题了。请检查你的网络连接并重启补丁器。如果你的网络连接没有问题，请联系客服进行处理。":" 在連線至伺服器時發生了問題。請確認您的網路狀態並重新開始更新。如果並不是您的網路問題，請至<a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/201752664\" target='_blank'>客服中心</a>尋找答案。","补丁器无法下载内容至你的硬盘。请检查下你的电脑，至少需要8GB的空闲容量和写入硬盘的必要权限才能安装《英雄联盟》。你可以联系我们的客服来获取更多有关这个错误的帮助。*注意*：点击“是”将关闭客户端。":"更新版本無法下載至你的硬碟。硬碟空間不夠通常是這項錯誤產生的原因。請確保你指定的硬碟至少有8 GB以上的空間，且具有安裝英雄聯盟至此硬碟的權限。如有問題，煩請至：<a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/202969434\" target='_blank'>這裡</a>。備註：點按「好」將會關閉用戶端。","我们的服务器出故障了，并且在阻止你下载补丁内容。我们正在给服务器另一次机会。你可以<a href=\"http://lol.qq.com/act/a20150326dqpd/\" target='_blank'>点此</a>查看我们的服务器状态。":"伺服器發生問題無法更新。我們將在嘗試一次，你可以至官網<a href=\"http://status.leagueoflegends.com\" target='_blank'>確認伺服器狀態</a>。","《英雄联盟》无法更新，因为你没有足够的硬盘空间。请至少释放{{Bytes}}空间然后重试。":"英雄聯盟無法更新，因為你沒有足夠的磁盤空間。請清空至少 {{Bytes}} 的空間，然後重試。","补丁更新失败，并且我们不确定原因是什么。请重启客户端并重试补丁更新。":"更新由於不明原因失敗了，請重新開啟客戶端嘗試","预计用时 {{number}}分钟":"預計完成時間 {{number}} 分鐘","文件无法写入硬盘。请检查你是否有足够的磁盘空间和必要的许可。":"複寫到磁碟失敗。請檢查您是否有足夠的硬碟空間和管理權限。","已修复档案：{{number}}":"檔案修復：{{number}}","已扫描的文件：{{number}}":"資料已掃描：{{number}}","联盟客户端":"聯盟","游戏客户端":"主程式","我们的服务器发生了些状况，导致你无法从服务器中获得更新文件。我们正在对服务器进行停机维护。在维护时，你可以在这里查看我们的服务器状态。":"我們的伺服器出現了一些問題，使您暫時無法更新。我們正在重新嘗試。同時您可以在這裡查看似服器服務狀態","这个错误也许由以下现网内部事故导致：":"以下的事件可能導致了錯誤產生：","我们已经将这个安装程序恢复至一个较早的《英雄联盟》版本、现在我们将尝试将它更新至最新版本。":"我們回復了英雄聯盟較舊版本的檔案，現在我們會更新到最新的版本。","正在应用版本补丁":"套用更新檔","正在下载文件":"下載檔案","正在提取所需的版本数据":"獲取更新資料","正在安装":"安裝中","正在下载":"下載中","正在修复":"修復中","正在扫描":"掃描中","修复":"修復","抱歉！我们在你的安装过程中检测到一些数据损坏。你想要修复受损的文件么？":"抱歉！我們偵測到有些檔案在安裝時可能出錯。您要修復受到影響的檔案嗎？","更新已完成下载。你必须重启客户端才能让更新生效。":"主程式更新已完成。你必須重新啟動英雄聯盟來啟用更新項目。","现在还不行":"晚點再說","重新启动":"重新啟動","第{{current_step}}步（共{{total_steps}}步）":"步驟 {{current_step}} ，總共 {{total_steps}} 個步驟","更新失败，而我们不确定是什么原因。点击我们的客服页面{{support page}}来查找可能的解决方法。":"因不明原因導致更新失敗。請查看我們的客服網頁 {{support page}} 來排除問題。","正在更新……":"更新中…","在更新《英雄联盟》时出现了一个问题。我们正在复原《英雄联盟》的备份版本，并会在你重新启动后再次尝试":"更新英雄聯盟時出現問題。我們會回復上一個版本並在重新啟動後再次嘗試","游戏仍在进行中…":"遊戲進行中...","全随机":"全部隨機","跳过等待，直接开始下一局游戏。":"跳過結算畫面","开始游戏":"開始遊戲","可用":"線上","剩余1日":"剩下 1 天","剩余{{days}}天":"剩餘{{days}}天","金币加成":"權力點加成","网吧特权加成":"忠誠權力點加成","下一个奖励的进度":"下次加成","下一次重随的进度":"下次重骰","没有激活加成":"無加成效果","剩余1胜":"剩下 1 勝","剩余{{wins}}胜场":"剩餘{{wins}}勝","双倍经验卡":"經驗加成","记分板":"計分板","下一个":"下一場","失败":"失敗","第1名":"第一","蓝色精萃":"藍色結晶粉末","全员战斗加成蓝色精萃已获得":"藍色結晶粉末戰鬥加成","蓝色精萃加成":"藍色結晶粉末加成","当天首次胜利":"當日首勝","蓝色精萃获取":"獲得藍色結晶粉末","特权加成蓝色精萃已获取":"藍色結晶粉末忠誠加成","统治战场蓝色精萃加成":"奧丁藍色結晶粉末","小队奖励蓝色精萃加成已获得":"派對獎勵藍色結晶粉末","排队加成已获取":"列隊獎勵","逃兵":"中離","等级":"等級","此负场不作记录":"不計敗場","加成点数":"額外點數","点数获取":"獲得點數","总计：":"總計：","胜利":"勝利","点数":"分數","总经验":"經驗總計","特权加成经验已获取":"忠誠加成經驗","经验已获取":"獲得經驗","还需{{points}}点即可到达{{level}}级":"仍需 {{points}} 經驗以達到等級 {{level}}","重新连接":"重新連線","游戏已经结束。你现在将返回主页。":"遊戲已結束，你將回到大廳。","您中途退出游戏，\n请重新连接。":"你離開了進行中的對戰，請重新連線。","添加好友":"新增好友","首页":"回到大廳","再玩一次":"再來一場","审核用的举报已经发送。感谢您的反馈。":"此檢舉已送至玩家行為團隊進行複查。感謝您。","你已经用完了所有可用的奖励。":"你已用完所有獎勵","确定":"好的","北":"北方","队伍2":"隊伍2","南":"南方","队伍1":"隊伍1","查看高级详情":"觀看進階紀錄","附加评论":"更多評論","给敌方放水":"幫助敵人","在这里输出评论":"在此輸入評論","不当的用户名":"不恰當的名稱","故意送人头":"惡意送頭","挂机":"中離／AFK","消极态度":"惡意遊戲態度","不与团队进行沟通":"與隊伍缺乏溝通","攻击性的语言":"攻擊性語言","举报":"檢舉","举报玩家":"檢舉玩家","滥发信息":"惡意洗頻","无法举报这个玩家。请稍后再试。":"無法檢舉此玩家，請稍後再試","玩家水平过低":"玩家操作技術不佳","口头谩骂":"言語攻擊","态度友好":"友善","乐于助人":"熱心助人","可敬的对手":"可敬的對手","无法称赞这个玩家。请稍后再试。":"無法給予此玩家獎勵，請稍後再試","团队合作":"團隊合作","英雄击杀":"擊殺英雄","金币获取":"獲得金錢","小兵击杀":"擊殺士兵","该局总分":"回合分數","召唤师等级：":"召喚師等級：","你确定要从英雄选择阶段离开吗？":"你確定要跳離英雄選擇畫面？","一位玩家秒退了；你已经回到了房间。":"一名玩家跳離了遊戲；你已回到組隊房間。","敌方队伍":"敵方隊伍","你有{{rerolls}}个可用的英雄重随机会。":"你還有 {{rerolls}} 次英雄重骰可以使用","这个召唤师技能已被禁用。":"此召喚師技能已被停用","等级需求：{{level}}":"等級{{level}}解鎖","{{actor}}正在和其他人交换":"{{actor}} 正在與其他人交換。","这个交换已被取消。":"這個交換被取消了。","交换已被拒绝。":"此交換已被拒絕。","还不能发出交换请求。请重试。":"無法傳送交換邀請。請重試。","{{actor}}想要用{{entity1}}交换{{entity2}}。":"{{actor}} 想用 {{entity1}} 換取你的 {{entity2}}。","用{{entity1}}交换{{entity2}}。":"用 {{entity1}} 換取 {{entity2}}。","正在等待{{actor}}回应你的交换请求……":"等待 {{actor}} 接受交換請求……","己方队伍":"己方隊伍","接受！":"接受","{{summonerName}}在英雄选择时离开。你已重新回到房间。":"{{summonerName}} 在選擇英雄時離開遊戲。你已回到組隊房間。","一名玩家在英雄选择时离开。你已重新回到房间。":"一名玩家在英雄選擇期間離開遊戲，你已回到列隊中。","对局已找到":"進入對戰","准备战斗":"準備戰鬥","对局已接受":"已接受對戰","对局已拒绝":"拒絕配對","正在等待其他玩家":"等候其他玩家","符文页{{number}}":"符文頁 {{number}}","选择全部":"全部選擇","都不选择":"取消選擇","选择玩家来解除聊天黑名单，然后点击保存。":"選擇取消封鎖的玩家，再按一下儲存。","按字母顺序排列":"依字母順序排列","开启语言过滤器":"開啟語言過濾","启动链接警告":"開啟連結警示","在线状态":"上線狀態","好友列表的排列顺序：":"依字母順序排列","启动菜单动画":"開啟選單動畫","启动警告弹窗":"開啟通知彈出","聊天黑名单":"封鎖清單","聊天&好友":"聊天 & 好友","恢复默认设置":"恢復預設選項","你确定要将所有选项重置为默认设置吗？":"你確定要重設所有設定為預設值嗎？","综合":"一般","键位绑定":"按鍵綁定","选项":"選項","全部恢复默认设置":"全部恢復預設選項","声音":"音效","如果你的《英雄联盟》出了什么毛病，就点击下方的修复按钮来搞定它吧！警告：这个操作会耗费很长一段时间。":"如果遊戲程式出現錯誤，請點擊下方的修復按鈕。注意：這將會需要花費一段很長的時間。","你真的想要修复吗？它会耗费很长一段时间！":"你真的要開始進行修復嗎？這將會需要一段時間！","英雄选择界面的音乐音量":"英雄選擇音樂音量","启动英雄选择界面的音乐":"開啟英雄選擇音樂","启动登陆音乐":"開啟登入音樂","启动音效":"開啟音效","关闭登录动画":"停用登入動畫","关闭登录音效":"停用登入音樂","选择":"選擇","传说之证 边框":"尊爵不凡讀取畫面飾框","排位边框":"積分牌階飾框","展示往届排位旗帜":"顯示過往積分牌階飾框。","无法保存。请稍后重试。":"無法儲存。請稍後再嘗試。","已选择":"已選擇","当前不可用。":"目前無法使用。","进行排位赛以解锁！":"進行積分來解鎖！","保存中":"儲存中","选择一个召唤师图标":"選擇一個召喚師頭像","召唤师图标&边框选择器":"召喚師頭像 & 讀取畫面飾框選取器","无法保存你的选择。":"儲存選項失敗。","屏障":"光盾","为你的英雄套上护盾，吸收115-455（取决于英雄等级）点伤害，持续2秒。":"產生暫時護盾保護英雄，可以吸收 115～455（取決於英雄等級）傷害，持續 2 秒。","将地图上任意一块区域暴露给你的队伍，持续5秒。":"偵察地圖上指定的目標區域，同隊皆可看到，持續5秒。","清晰术":"清晰","为你的英雄回复40%的最大法力值。也会为友军回复他们40%的最大法力值":"回復自己 40% 最大魔力。同時回復周圍友軍 40% 最大魔力。","净化":"淨化","移除身上的所有限制效果和召唤师技能的减益效果，并且若在接下来的3秒里再次被施加限制效果时，新效果的持续时间会减少65%。":"移除自身全部控制技能和召喚師技能的減益效果，同時降低 3 秒內受到的控制技能 65% 時間。","虚弱":"虛弱","虚弱目标敌方英雄，降低目标英雄30%的移动速度和攻击速度，以及10护甲与魔法抗性，并且他们所造成的伤害减少40%，持续2.5秒。":"虛若目標英雄，降低其 30% 攻速、10 點物理與魔法防禦，期間降低其 40% 輸出，持續 2.5 秒。","闪现":"閃現","使英雄朝着你的指针所停的区域瞬间传送一小段距离。":"英雄朝著滑鼠游標指向的位置瞬間傳送一小段距離。","卫戍部队":"駐守","友方防御塔：提供巨量回复，持续8秒。敌方防御塔：降低伤害输出，持续8秒":"友方據點：大幅提高據點佔領光暈的回復速度，持續 8 秒；敵方據點：降低據點護塔 80% 攻擊傷害，持續 8 秒。","幽灵疾步":"鬼步","你的英雄在移动时会无视单位的碰撞体积，移动速度增加27%，持续10秒。":"英雄可以不受阻礙地在目標間移動，同時提高 27% 跑速，持續 10 秒。","治疗术":"治癒","为你和目标友军英雄回复95-345（取决于英雄等级）生命值，并为你和目标友军英雄提供30%移动速度加成，持续1秒。若目标近期已受到过其它治疗术的影响，则治疗术对目标产生的治疗效果减半。":"回復 90～345 生命（取決於英雄等級）並使自己與目標友軍獲得 30% 額外跑速，持續 1 秒。對已接受過治療的單位僅會造成一半效果。","引燃":"點燃","引燃是对单体敌方目标施放的持续性伤害技能，在5秒的持续时间里造成70-410（取决于英雄等级）真实伤害，获得目标的视野，并减少目标所受的治疗和回复效果。":"點燃敵方英雄，在 5 秒內造成 70～410 真實傷害（取決於英雄等級），同時獲得該敵軍視野，並且在作用期間降低目標治癒效果。","标记":"印記","沿直线扔出一个雪球。如果雪球命中了一个敌人，那么这个敌人会被【标记】，并且你的英雄接下来可以快速突进到被【标记】的目标旁边。":"往前丟出雪球，若擊中敵人則標記該單位，你將可以快速移動至單位旁。","魄罗投掷":"普羅投擲","把一个魄罗投向你的敌人。如果它命中了一名敌人，那么你接下来就可以快速位移到被命中的敌人旁边。":"往敵軍投擲普羅，如果命中，你能快速移動至目標旁。","立刻在本队的召唤师平台上复活你的英雄，并暂时提升英雄的移动速度。":"立刻在召喚師基地重生你的英雄，並且獲得攻速，持續一小段時間。","惩戒":"重擊","对目标史诗野怪、大型野怪或敌方小兵造成390-1000（取决于英雄等级）点真实伤害。":"對大型野怪、史詩野怪或是敵方士兵造成 390～1000 真實傷害（取決於英雄等級）。","传送":"傳送","在引导3.5秒后，将英雄传送到目标友方建筑物、小兵或守卫旁边。":"施放技能經過3.5秒後，英雄可以傳送至友軍士兵、友方防禦塔、或偵察守衛旁。","护驾！":"為了吾王！","快速位移到魄罗之王旁边。":"迅速移動至普羅王旁邊。","立刻领取":"立即","免费":"免費","设置数量":"設定數量","你没有足够的代币。":"代幣不足","输入至少{{minQuantity}}个。":"請輸入至少{{minQuantity}}","你只能以{{minQuantity}}的倍数来购买。":"只能購買{{minQuantity}}的倍數","愚人节快乐，乐子人们！来庆祝一下吧！ ":"愚人節快樂！一起狂歡慶祝吧！","愚人节大军需要增援，而你就是那个完美的呆萌士兵！":"愚人節大軍需要擴編，憑你的傻勁絕對可以成為我們最佳生力軍！","冲啊！我的无-羽-伦比的派对礼品就给你拿去用来对抗混乱大军吧。":"戰吧！戰吧！用我的鵝咿細派對小禮物來對抗狂暴勢力。","在非排位的【召唤师峡谷】，【极地大乱斗】和【人机对战】里找我。我们在黎明时兜风！":"我在召喚峽谷一般對戰、隨機單中和玩家 vs. 電腦模式等著你。一起出發戰鬥吧！","咕噜噜……(“你不玩吗？我可为你准备了很多愚人节惊喜……”)":"呼嚕……(來玩嘛。我為你準備了滿滿的愚人節驚喜喵……)","喵呜！ (“捏哈哈！有本事来抓我呀！”)":"喵！(吶吶！快來抓我啊喵！)","咪嗷呜！ (“混乱就是我的地盘！一场喵灾在等待！”)":"喵嗚！(搞破壞我最在行！災難要來臨了喵！)","企鹅 盖伦":"鵝鵝騎士 蓋倫","盒子猫 萨科":"薛丁格的貓 薩科"};
  const patterns = [];
  try {
    window.__tr = createTextReplacer({ dict, patterns, collect: true });
  } catch (error) {
    /* 最坏情况: 什么都没发生, 客户端保持原样 */
  }
})();
