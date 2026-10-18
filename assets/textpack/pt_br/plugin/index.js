/* 自动生成, 请勿手改 —— 由 scripts/build-text-plugin.ts 从 runtime.mjs + pt_br/dict.json 生成 */
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
  const dict = {"护甲":"Armadura","攻击速度":"Velocidade de Ataque","格挡":"Bloquear","暴击几率":"Chance de Acerto Crítico","暴击伤害":"Dano de Acerto Crítico","能量":"Energia","能量回复/5秒":"Regeneração de Energia / 5 s","经验值":"Experiência","生命值":"Vida","生命回复/5秒":"Regeneração de Vida / 5 s","法术强度":"Poder de Habilidade","移动速度":"Velocidade de Movimento","法力":"Mana","法力回复/5秒":"Regeneração de Mana / 5 s","攻击力":"Dano de Ataque","魔法抗性":"Resistência Mágica","闪避":"Esquiva","经验获取":"Experiência Recebida","生命回复":"Regeneração de Vida","生命偷取":"Roubo de Vida","法力回复":"Regeneração de Mana","法术吸血":"Vampirismo Mágico","护甲于18级":"Armadura no nv. 18","护甲穿透":"Penetração de Armadura","护甲穿透于18级":"Penetração de Armadura no nível 18","暴击几率于18级":"Chance de Acerto Crítico no nv. 18","暴击伤害于18级":"Dano de Acerto Crítico no nv. 18","闪避于18级":"Esquiva no nv. 18","能量于18级":"Energia no nv. 18","能量回复于18级":"Regeneração de Energia no nv. 18","金/10秒":"Ouro / 10 s","生命值于18级":"Vida no nv. 18","生命回复于18级":"Regeneração de Vida no nv. 18","法术强度于18级":"Poder de Habilidade no nv. 18","法术穿透":"Penetração Mágica","法术穿透于18级":"Penetração Mágica no nv. 18","移动速度于18级":"Velocidade de Movimento no nv. 18","法力于18级":"Mana no nível 18","法力回复于18级":"Regeneração de Mana no nv. 18","攻击力于18级":"Dano de Ataque no nv. 18","魔法抗性于18级":"Resistência Mágica no nv. 18","死亡时间":"Tempo Decorrido em Morte","死亡时间于18级":"Tempo Decorrido em Morte no nv. 18","攻击速度于18级":"Velocidade de Ataque no nv. 18","冷却缩减":"Redução do Tempo de Recarga","冷却缩减于18级":"Redução do Tempo de Recarga no nv. 18","穿甲":"Letalidade","穿甲于18级":"Letalidade no nv. 18","正在更新《英雄联盟》……":"Atualizando League of Legends...",";annie;安妮;黑暗之女;heianzhinv;huonv;火女;an;hazn;hn":";annie",";kayle;kaier;凯尔;tianshi;天使;审判;ke;ts;shenpan;spts":";kayle",";xerath;zelasi;泽拉斯;tesila;特斯拉;yuanguwuling;远古巫灵;zls;tsl;ygwl":";xerath",";shyvana;龙女;longnv;xiwana;希瓦娜;龙血武姬;longxuewuji;ln;xwn;lxwj":";shyvana",";ahri;ali;阿狸;huli;狐狸;九尾妖狐;jiuweiyaohu;hl;jwyh":";ahri",";graves;格雷福斯;geleifusi;法外狂徒;fawaikuangtu;nanqiang;男枪;nq;glfs;fwkt":";graves",";fizz;feizi;chaoxihailing;菲兹;潮汐海灵;xiaoyuren;小鱼人;fz;cxhl;xyr":";fizz",";volibear;gouxiong;狗熊;wolibeier;沃利贝尔;不灭狂雷;bumiekuanglei;gx;wlbe;bmkl":";volibear",";rengar;shizigou;狮子狗;leienjiaer;雷恩加尔;aozhizhuiliezhe;傲之追猎者;szg;leje;azzlz":";rengar",";master yi;yidashi;易大师;jiansheng;剑圣;wuji;无极;yds;js;wjjs;yi":";master yi",";varus;weilusi;韦鲁斯;chengjiezhijian;惩戒之箭;wls;cjzj":";varus",";nautilus;taitan;泰坦;nuotilesi;诺提勒斯;shenhai;深海;ntls;sstt;tt":";nautilus",";viktor;weiketuo;维克托;jixiexianqu;机械先驱;三只手;sanzhishou;szs;wkt;jxxq;aoshuxianqu;asxq;奥术先驱":";viktor",";sejuani;zhunv;zhumei;猪女;猪妹;sezhuangni;瑟庄妮;beidizhinu;北地之怒;szn;zn;zm;bdzn":";sejuani",";fiora;剑姬;jianji;feiaona;菲奥娜;wushuang;无双;fan;fon;jj;wsjj":";fiora",";ziggs;zhadanren;炸弹人;吉格斯;jigesi;guicai;鬼才;baopo;爆破;jgs;bpgc;gc;zdr":";ziggs",";lulu;璐璐;露露;仙灵女巫;xianlingnvwu;ll;xlnw":";lulu",";draven;德莱文;delaiwen;文森特;wensente;rongyaoxingxingguan;荣耀行刑官;dlw;wst;ryxxg":";draven",";alistar;niutou;牛头;alisita;阿利斯塔;nt;alst":";alistar",";hecarim;hekalimu;赫卡里姆;renma;人马;zhanzhengzhiying;战争之影;hklm;rm;zzzy":";hecarim",";kha'zix;tanglang;螳螂;kazike;卡兹克;xukong;虚空;tl;kzk;xk":";kha'zix;khazix",";darius;delaiesi;德莱厄斯;nuoshou;诺手;dles;ns;诺克萨斯之手;nuokesasizhishou;nksszs":";darius",";jayce;jiesi;杰斯;weilaishouhuzhe;未来守护者;js;wlshz":";jayce",";lissandra;bingnv;冰女;lisangzhuo;丽桑卓;bingshuangnvwu;冰霜女巫;bn;lsz;bsnw":";lissandra",";ryze;faker;liulang;流浪;瑞兹;ruizi;fuwenfashi;符文法师;guangtou;光头;rz;ll;fwfs;gt":";ryze",";diana;daianna;黛安娜;jiaoyue;皎月女神;戴安娜;dan;jyns;jy":";diana",";quinn;kuiyin;奎因;niaoren;鸟人;demaxiyazhiyi;德玛西亚之翼;ky;dmxyzy":";quinn",";syndra;qiunv;球女;xindela;辛德拉;anheiyuanshou;暗黑元首;qn;xdl;ahys":";syndra",";aurelion sol;龙王;奥瑞利安;索尔;zhuxing;longwang;铸星;aoruilian;arla;lw;zxlw":";aurelion sol",";sion;saien;赛恩;wanglingzhanshen;亡灵战神;se;wlzs":";sion",";凯隐;kaiyin;kayn;暗裔魔镰;anyimolian;yingliuzhilian;影流之镰;ky;ayml;ylzl":";kayn",";zoe;zuoyi;佐伊;muguangxingling;暮光星灵;zy;mgxl;":";zoe",";zyra;jiela;婕拉;jingjizhixing;荆棘之兴;jl;jjzx":";zyra",";kai'sa;kasha;xukong;虚空;卡莎;ks;xkzn":";kai'sa",";Seraphine;salefenni;geji;slfn;xlgj;gj;萨勒芬妮;星籁;歌姬;酸辣粉;suanlafen":";Seraphine",";qiyana;qyn;ysnh;yuansunvhuang;奇亚娜;元素女皇;圈子妈;quanzima":";qiyana",";sivir;xiweier;希维尔;lunzima;轮子妈;zhanzhengnvshen;战争女神;xwe;lzm;zzns":";sivir",";gnar;naer;纳尔;mishizhiya;迷失之牙;ne;mszy":";gnar",";zac;zhake;扎克;shenghuamoren;生化魔人;zk;shmr":";zac",";yasuo;kuaile;fengnan;快乐;风男;亚索;jianhao;剑豪;jifeng;疾风;ys;jfjh;klfn":";yasuo",";soraka;naima;奶妈;索拉卡;suolaka;slk;nm;星妈;xingma;xm":";soraka",";vel'koz;大眼;dayan;weikezi;维克兹;xukong;虚空;dy;wkz;xkzy":";vel'koz;velkoz",";taliyah;taliya;塔利亚;塔莉垭;yanque;岩雀;tly;yq":";taliyah",";camille;青钢影;卡蜜尔;qinggangying;kamier;qgy;kme":";camille",";akshan;阿克尚;影哨;the Rogue Sentinel;aks;akeshang;yingshao;ys":";akshan",";teemo;timo;提莫;tibaiwan;提百万;xunjiechihou;迅捷斥候;tm;xjch":";teemo",";tristana;xiaopao;小炮;paoniang;炮娘;崔丝塔娜;cuisitana;mailinpaoshou;麦林炮手;xp;cstn;mlps":";tristana",";warwick;langren;狼人;wolike;沃里克;祖安怒兽;zuan;wlk;lr;zans":";warwick",";olaf;aolafu;奥拉夫;kuangzhanshi;狂战士;alf;kzs":";olaf",";nunu;努努;xueren;雪人;xueyuanshuangzi;雪原双子;xr;xysz;nn":";nunu",";belveth;beierweisi;xukongnvhuang;brws;xknh;Void Empress;卑尔维斯;虚空;女皇;虚空女皇;nvhuang;nh":";belveth",";braum;bulong;布隆;fuleierzhuode;弗雷尔卓德;bl;flezd":";braum",";jhin;烬;戏命师;jin;wangyuan;望远;ximingshi;xms;wyj":";jhin",";kindred;qianjue;千珏;yonglieshuangzi;永猎双子;qj;ylsz":";kindred",";miss fortune;nvqiang;女枪;mf;eyunxiaojie;厄运小姐;haoyunjie;好运姐;shangjin;赏金;nq;eyxj;sj;hyj":";miss fortune",";ashe;aishe;爱射;aixi;艾希;hanbing;寒冰;as;ax;hb":";ashe",";zeli;zeri;zuanhuahuo;zahh;泽丽;zl;祖安花火":";zeri",";jinx;jinkesi;金克丝;baozou;luoli;暴走;萝莉;jks;bzll;powder;baobao;bb;爆爆":";jinx",";tahm kench;hama;蛤蟆;tamu;塔姆;hm;tm;河流之王;hlzw;heliuzhiwang":";tahm kench",";tryndamere;manwang;蛮王;taidamier;泰达米尔;mw;tdme":";tryndamere",";briar;the Restrained Hunger;贝蕾亚;狂厄蔷薇;bly;keqw;beileiya;kuangeqiangwei":";briar",";viego;Ruined King;佛耶戈;破败之王;v哥;foyege;fyg;pobaizhiwang;pbzw;破败王;pobaiwang;pbw":";viego",";saina;senna;赛娜;dihunshengqiang;涤魂圣枪;sn;dhsq":";senna",";lucian;aobama;奥巴马;luxian;卢锡安;shengqiangyouxia;圣枪游侠;abm;lxa;sqyx":";lucian",";zed;jie;劫;yingliuzhizhu;影流之主;ylzz":";zed",";jax;jiakesi;贾克斯;wuqidashi;武器大师;jks;wqds;武器":";jax",";kled;克烈;暴怒骑士;kelie;baonuqishi;kl;bnqs":";kled",";ekko;aike;艾克;时间刺客;shijiancike;ak;sjck":";ekko",";morgana;moganna;莫甘娜;duoluotianshi;堕落天使;mgn;dlts":";morgana",";vi;wei;蔚;pichengzhifaguan;皮城执法官;pczfg;violet;蔚奥莱;weiaolai;wal;楚雨荨;chuyuxun;cyx":";vi",";zilean;shiguang;laotou;时光;老头;jilan;基兰;sg;jl":";zilean",";aatrox;yatuokesi;亚托克斯;jianmo;剑魔;anyi;暗裔;ytks;jm;ayjm":";aatrox",";nami;namei;娜美;huanchaojiaoji;唤潮鲛姬;nm;hcjj":";nami",";azir;shahuang;沙皇;azier;阿兹尔;shamohuangdi;沙漠皇帝;sh;aze;smhd":";azir",";singed;lianjin;炼金;xinjide;辛吉德;lj;xjd":";singed",";evelynn;guafu;寡妇;yifulin;伊芙琳;tongkuzhiyong;痛苦之拥;gf;yfl;tkzy":";evelynn",";twitch;laoshu;老鼠;tuqi;图奇;wenyizhiyuan;瘟疫之源;ls;tq;wyzy":";twitch",";galio;jialiao;加里奥;zhengyijuxiang;正义巨像;jla;jlo;zyjx":";galio",";karthus;sige;死歌;kaersasi;卡尔萨斯;sg;kess":";karthus",";cho'gath;kejiasi;科加斯;dachongzi;大虫子;xukong;虚空恐惧;kjs;dcz;xkkj":";cho'gath;chogath",";amumu;阿木木;munaiyi;木乃伊;amm;mny":";amumu",";rammus;longgui;wangba;龙龟;王八;lamosi;拉莫斯;lms;lg;wb":";rammus",";anivia;bingniao;冰鸟;fenghuang;凤凰;ainiweiya;艾尼维亚;bn;fh;anwy":";anivia",";shaco;xiaochou;小丑;sake;萨科;xc;sk":";shaco",";youmi;yuumi;maomi;cat;mfmm;魔法猫咪;猫咪;魔法;悠米;ym;mm":";yuumi",";dr. mundo;mengduo;蒙多;zuan;祖安狂人;md;zakr":";dr. mundo",";samira;沙漠玫瑰;莎弥拉;shamila;desert rose;samila;shamomeigui;萨米拉;sml;smmg":";samira",";sona;qinnv;琴女;suona;娑娜;qinsexiannv;琴瑟仙女;sn;qn;qsxn":";sona",";kassadin;kasading;卡萨丁;xukong;虚空行者;xkxz;xukongxingzhe;ksd":";kassadin",";irelia;daomei;刀妹;airuiliya;艾瑞丽娅;daofengwuzhe;刀锋舞者;dm;arly;dfwz;女刀;nd;nvdao":";irelia",";twisted fate;tf;kapai;卡牌大师;cuisite;崔斯特;kp;kpds;kapaidashi;cst":";twisted fate",";janna;998;fengnv;风女;jiana;迦娜;fengbaozhinu;风暴之怒;fn;jn;fbzn":";janna",";gangplank;chuanzhang;船长;pulangke;普朗克;haiyangzhizai;海洋之灾;cz;plk;hyzz":";gangplank",";thresh;chuishi;锤石;hunsuodianyuzhang;魂锁典狱长;cs;hsdyz":";thresh",";corki;feiji;飞机;kuqi;库奇;yingyongtoudanshou;英勇投弹手;fj;kq;yytds":";corki",";illaoi;eluoyi;俄洛伊;haishoujisi;海兽祭司;chushouma;触手妈;大妈;dama;ely;hsjs;csm;dm":";illaoi",";rek'sai;leikesai;雷克塞;挖掘机;wajueji;xukongdundishou;虚空;lks;wjj;xkdds":";rek'sai;reksai",";ivern;艾翁;翠神;aiweng;cuishen;xiaoju;小菊;aw;cs;xj;xiaoshu;xs;小树":";ivern",";kalista;huabanxie;滑板鞋;kalisita;卡莉丝塔;fuchouzhimao;复仇之矛;hbx;klst;fczm":";kalista",";karma;shanzima;扇子妈;kaerma;卡尔玛;tianqizhe;天启者;kem;szm;tqz":";karma",";bard;bade;巴德;yinyoushiren;吟游诗人;xingjieyoushen;星界游神;bd;yysr;xjys":";bardo",";taric;baoshi;宝石;talike;塔里克;waluolanzhidun;瓦洛兰之盾;tlk;bs;wllzd":";taric",";veigar;weijia;维迦;xieexiaofashi;邪恶小法师;wj;xiaofashi;小法师;xfs;xexfs;小法":";veigar",";trundle;jumo;巨魔;telangdeer;特朗德尔;tlde;jm":";trundle",";rakan;洛;幻翎;luo;huanling;fenghuangchuanqi;凤凰传奇;hl;fhcq":";rakan",";xayah;霞;逆羽;xia;niyu;fenghuangchuanqi;凤凰传奇;fhcq;ny":";xayah",";xin zhao;zhaoxin;赵信;xinye;信爷;zx;xy;debangzongguan;德邦总管;dbzg":";xin zhao",";swain;wuya;乌鸦;siweiyin;斯维因;nuokesasitongling;诺克萨斯统领;wy;swy;nksstl":";swain",";caitlyn;nvjing;女警;kaitelin;凯特琳;picheng;皮城;nj;ktl;pcnj;cupcake;xiaodangao;xdg;小蛋糕":";caitlyn",";ornn;奥恩;山隐之焰;aoen;shanyinzhiyan;ae;syzy;yang;羊":";ornn;carneirao",";解脱者;sailasi;sls;jtz;jietuozhe;sylas;Unshackled;塞拉斯":";sylas",";nikou;neeko;wanhua;whtl;nk;妮蔻;万花通灵":";neeko",";efeiliusi;aphelios;the Weapon of Faith;canyuezhisu;厄斐琉斯;残月之肃;无E烦;wuefan;wuyifan;月男;yuenan;efls;cyzs;yn;wyf":";aphelios",";rell;ruier;芮尔;铁女;Iron Maiden;镕铁少女;re;rongtieshaonv;rtsn;tienv;tn;mamei;mm;马妹":";rell",";blitzcrank;jiqiren;机器人;bulici;布里茨;jqr;blc;zhengqi;蒸汽;zqjqr":";blitzcrank",";malphite;shitouren;石头人;mofeite;墨菲特;rongyanjushou;熔岩巨兽;str;mft;ryjs;ry":";malphite",";katarina;katelinna;卡特琳娜;buxiangzhiren;不祥之刃;卡特;kate;ktln;kt;bxzr":";katarina",";pyke;paike;派克;xuegangguiying;血港鬼影;pk;xggy":";pyke",";nocturne;mengyan;梦魇;moteng;魔腾;my;mt;夜曲;yequ;yq":";nocturne",";maokai;茂凯;dashu;大树;niuqushujing;扭曲树精;mk;ds;nqsj":";maokai",";renekton;eyu;鳄鱼;leikedun;雷克顿;huangmotufu;荒漠屠夫;lkd;hmtf":";renekton",";jarvan iv;huangzi;皇子;jiawensishi;嘉文四世;hz;jwss;dmxyhz;demaxiyahuangzi;德玛西亚皇子":";jarvan iv",";urgot;pangxie;螃蟹;ejiate;厄加特;wuweizhanche;无畏战车;ejt;dpx;px;大螃蟹;wwzc":";urgot",";elise;zhizhu;蜘蛛;yilisi;伊莉丝;zznh;女皇;yls":";elise",";orianna;fatiao;发条;aolianna;奥莉安娜;ft;alan;魔灵;ftml":";orianna",";wukong;悟空;houzi;猴子;qitiandasheng;齐天大圣;孙悟空;swk;wk;hz;qtds;sunwukong":";wukong",";brand;huonan;火男;bulande;布兰德;fuchouyanhun;复仇焰魂;bld;hn;fcyh":";brand",";lee sin;xiazi;盲僧;瞎子;mangseng;liqing;李青;xz;ms;lq":";lee sin",";vayne;uzi;weien;薇恩;anyelieshou;暗夜猎手;we;ayls":";vayne",";rumble;lanbo;兰博;jixiegongdi;机械公敌;lb;jxgd":";rumble",";cassiopeia;shenv;蛇女;kaxiaopeiya;卡西奥佩娅;moshezhiyong;魔蛇之拥;sn;kxopy;mszy":";cassiopeia",";leblanc;yaoji;妖姬;lefulan;乐芙兰;yj;lfl;诡术妖姬;guishu;gsyj":";leblanc",";vex;gloomist;薇古丝;愁云使者;vgs;cysz;wgs;weigusi;veigusi;chouyunshizhe;aybb;aoyebobi;熬夜波比":";vex",";skarner;xiezi;蝎子;sikana;斯卡纳;shanggulingzhu;上古领主;xz;skn;sglz":";skarner",";heimerdinger;datou;大头;dafamingjia;大发明家;heimodingge;黑默丁格;dt;dmmj;hmdg;famingjia;fmj;发明家":";heimerdinger",";nasus;goutou;狗头;neisesi;内瑟斯;shamosishen;沙漠死神;nss;gt;smss":";nasus",";nidalee;naidali;奶大力;baonv;豹女;naideli;奈德丽;kuangyenvlieshou;狂野女猎手;ndl;bn;kynls":";nidalee",";udyr;wudier;乌迪尔;shoulingxingzhe;兽灵行者;ud;wde;slxz;xiaoyan;xy;萧炎;野区萧炎;yequxiaoyan;yqxy":";udyr",";yone;永恩;封魔剑魂;yongen;fengmojianhun;fmjh;ye":";yone",";poppy;bobi;波比;圣锤之毅;shengchuizhiyi;bb;sczy":";poppy",";gragas;jiutong;酒桶;gulajiasi;古拉加斯;gljs;jt":";gragas",";ambessa;anbeisa;tiexielangmu;tiexuelangmu;txlm;abs;安蓓萨;铁血狼母;狼母;langmu;lm":";ambessa",";vladimir;xixuegui;吸血鬼;fulajimier;弗拉基米尔;xinghongshougezhe;猩红收割者;xxg;fljme;xhsgz":";vladimir",";pantheon;pansen;潘森;sibada;斯巴达;buquzhiqiang;不屈之枪;ps;bqzq":";pantheon",";mel;jingyingliuguang;meier;梅尔;me;镜影流光;jylg;流光镜影;liuguangjingying;lgjy":";mel",";yunana;芸阿娜;不破之誓;the Unbroken Faith;yan;yunara;bupozhishi;bpzs":";yunara",";locke;灰烬驱魔人;洛克;the Ashen Exorcist;hjqmr;huijinqumoren;luoke;lk":";locke",";ezreal;ez;yize;伊泽;tanxianjia;探险家;yz;txj;yizeruier;伊泽瑞尔;yzre":";ezreal",";mordekaiser;tienan;铁男;modekaisa;莫德凯撒;tiekaiminghun;铁铠冥魂;mdks;jsds;jinshudashi;金属大师;modeganqing;莫得感情;tn;mdgq;tkmh":";mordekaiser",";yorick;yuelike;约里克;juemu;掘墓;muhunren;牧魂人;ylk;jm;mhr":";yorick",";akali;阿卡丽;liqunzhici;离群之刺;akl;lqzc":";akali",";kennen;kainan;凯南;dianhaozi;电耗子;kuangbaozhixin;狂暴之心;kn;kbzx":";kennen",";garen;gailun;盖伦;德玛西亚之力;demaxiyazhili;gl;dmxyzl":";garen",";seti;sett;the Boss;瑟提;st;腕豪;wh;wanhao;男拳;nanquan;nq":";sett",";莉莉娅;liliya;hxbl;hanxiubeilei;lillia;含羞;蓓蕾;妮马;蔻马;nima;kouma;鹿女;lunv;梦鹿;menglu;beilei;lly":";lillia",";gwen;gewen;the Hallowed Seamstress;灵罗娃娃;格温;gw;llww;lingluowawa;剪子妈;jianzima;jzm;剪妹;jianmei;jm;一剪没;yijianmei;yjm;滚;gun":";gwen",";lienata;lnt;lianjinnanjue;ljnj;renata;chemtech;baroness;烈娜塔;炼金男爵;glsk;gelasike;戈拉斯克;glasc":";renata glasc",";leona;nvtan;rinv;女坦;日女;leiouna;蕾欧娜;shuguangnvshen;曙光女神;lon;rn;nt;sgns":";leona",";阿萝拉;aluola;aurora;双界灵兔;shuangjielingtu;sjlt;all;兔女;tunv;tn;tuzi;tz;兔子":";aurora",";nila;nilah;the Joy Unbound;尼菈;nl;不羁之悦;bujizhiyue;bjzy":";nilah",";k'sante;kuisangti;kst;nazumangrongyao;nzmry;奎桑提;纳祖芒荣耀":";k'sante",";fiddlesticks;daocaoren;稻草人;feidetike;费德提克;yuangukongju;远古恐惧;dcr;fdtk;ygkj":";fiddlesticks",";malzahar;mazha;蚂蚱;maerzhaha;玛尔扎哈;xukongxingzhe;虚空先知;mezh;mz;xkxz":";malzahar",";simode;smolder;youlong;long;chiyan;chulong;chiyanchulong;炽;龙;炽炎雏龙;斯莫德;smd;cycl;yl;幼龙;xiaolongren;xlr;小龙人;小火龙;xiaohuolong;xhl;mabaolong;mbl;妈宝龙":";smolder",";milio;the gentle flame;mingzhu;miliou;mlo;mz;米利欧;明烛":";milio",";zaahen;The Unsundered;不落魔锋;亚恒;yaheng;buluomofeng;yh;blmf":";zaahen",";talon;nandao;男刀;tailong;泰隆;daofengzhiying;刀锋之影;tl;nd;df":";talon",";hwei;彗;hui;yihuashi;the Visionary;huajia;画家;异画师;yhs;hj;maobiren;mbr;毛笔人":";hwei",";riven;ruiwen;锐雯;fangzhuzhiren;放逐之刃;rw;fzzr":";riven",";naafiri;the Hound of a Hundred Bites;纳亚菲利;百裂冥犬;nayafeili;nyfl;bailiemingquan;blmq;gou;狗;dog":";naafiri",";kog'maw;dazui;大嘴;kegemo;克格莫;shenyuanjukou;深渊巨口;kgm;dz;shenyuanjukou;syjk":";kog'maw;kogmaw",";shen;慎;muguangzhiyan;暮光之眼;yaozi;腰子;mgzy;yz":";shen",";lux;lakesi;拉克丝;guanghuinvlang;光辉女郎;lks;ghnl":";lux","见习刺客":"Ladrão","初级刺客":"Espreitador","中级刺客":"Degolador","高级刺客":"Sanguinário","杀戮之影":"Assassino","杀戮宗师":"Carrasco","死神":"Mestre da Morte","见习战士":"Brigão","初级战士":"Combatente","中级战士":"Guerreiro","高级战士":"Veterano","征服之刃":"Destruidor","征服宗师":"Anunciador","战神":"Mestre da Guerra","见习法师":"Iniciado","初级法师":"Conjurador","中级法师":"Emanador","高级法师":"Mago","织法之杖":"Bruxo","织法宗师":"Feiticeiro","法神":"Arquimago","见习射手":"Batedor","初级射手":"Trilhador","中级射手":"Patrulheiro","高级射手":"Desbravador","鹰隼之眼":"Cria-Trilhas","射击宗师":"Bala no Alvo","狙神":"Atirador de Elite","见习辅助":"Ajudante","初级辅助":"Protetor","中级辅助":"Mantenedor","高级辅助":"Defensor","庇护之光":"Guardião","庇护宗师":"Sentinela","守护之神":"Vigia","见习坦克":"Troglodita","初级坦克":"Detonador","中级坦克":"Bastião","高级坦克":"Impositor","无畏之盾":"Brutamontes","无畏宗师":"Colosso","巨神":"Titã","登录失败，请重试。":"Combinação de nome de usuário/senha inválida. Por favor, tente novamente.","一个意料之外的错误发生了":"Ocorreu um erro inesperado","所有角色定位":"Todas as funções","刺客":"Assassino","战士":"Lutador","法师":"Mago","射手":"Atirador","辅助":"Suporte","坦克":"Tanque","错误代码":"Código do erro","我们无法加载这个页面。如果你的互联网连接没问题的话，请稍等几分钟然后重试。":"Não foi possível carregar essa página. Se a sua conexão com a internet estiver funcionando, aguarde alguns minutos e tente novamente.","重试":"Tentar novamente","{{feature}}目前已被禁用":"{{feature}} atualmente desativado(a)","这个功能目前已被禁用":"Este recurso está atualmente desativado","暂未实装":"Ainda não implementado","创建房间":"CRIAR SAGUÃO","退出":"SAIR","对水晶之痕的简短描述。":"Uma breve descrição de Crystal Scar.","和随机选择英雄的队友一起，去摧毁敌人的水晶枢纽。":"Batalhe como uma equipe de cinco Campeões selecionados aleatoriamente para sitiar a ponte e capturar o Nexus inimigo.","正义之地最古老最威严的战场当属召唤师峡谷。几百年间无数对立的召唤师们在这片战场上延续着战斗，这片战场也因此而得名。有三条不同的道路穿越整个战场。与友军一起攻击敌人最脆弱的地方，摧毁他们的基地！":"O mais antigo e mais venerado Campo da Justiça é conhecido como Summoner's Rift. O Vale de Summoner's Rift fica em uma floresta remota entre Freljord, o Rio Serpentino e os Montes Ferrifarpos.","对扭曲丛林的简短描述。":"Uma breve descrição de Twisted Treeline.","水晶之痕":"Crystal Scar","水晶\n之痕":"CRYSTAL SCAR","已被禁用，并在维修中。我们对此带来的不便深表歉意。":"foi desativado para manutenção. Pedimos desculpas por qualquer inconveniência.","嚎哭深渊":"Howling Abyss","嚎哭\n深渊":"HOWLING\nABYSS","召唤师峡谷":"Summoner's Rift","召唤师\n峡谷":"SUMMONER'S RIFT","扭曲丛林":"Twisted Treeline","扭曲\n丛林":"TWISTED TREELINE","创建自定义游戏":"Criar partida personalizada","这个模式目前已被禁用":"Modo atualmente desativado","加入自定义游戏":"Entrar em partida personalizada","匹配模式":"Normal","排位赛":"Ranqueada","新手教程":"Tutorial","人机":"Coop. vs. IA","极地大乱斗":"ARAM","全随机（极地大乱斗）1v1":"Todos Aleatórios (ARAM) 1 vs. 1","全随机（极地大乱斗）2v2":"Todos Aleatórios (ARAM) 2 vs. 2","全随机（极地大乱斗）3v3":"Todos Aleatórios (ARAM) 3 vs. 3","全随机（极地大乱斗）5v5":"Todos Aleatórios (ARAM) 5 vs. 5","全随机（极地大乱斗）6v6":"Todos Aleatórios (ARAM) 6 vs. 6","全随机人机对战（极地大乱斗）5v5":"Todos Aleatórios vs. IA (ARAM) 5 vs. 5","统治战场5v5":"Dominion 5 V 5","极地大乱斗5v5":"ARAM 5 V 5","经典模式5v5":"Clássico 5 V 5","经典模式3v3":"Clássico 3 V 3","全随机（大乱斗）":"TODOS ALEATÓRIOS (ARAM)","内部服务器错误，请稍后重试":"Erro interno do servidor. Tente novamente mais tarde.","你已经与新闻服务断开了连接。请手动重新连接。":"Você foi desconectado(a) do serviço de notícias. Por favor, reconecte-se manualmente.","经常使用":"Jogado frequentemente","确认":"OK","是":"Sim","否":"Não","接受":"ACEITAR","拒绝":"RECUSAR","最终用户许可协议":"CONTRATO DE LICENÇA COM O USUÁRIO FINAL","使用条款":"TERMOS DE USO","取消":"Cancelar","授予邀请":"Conceder convites","移出玩家":"Expulsar","提升为队长":"Promover a Capitão","撤回邀请":"Revogar convites","通过拖动来邀请玩家。":"Arraste para convidar","寻找对局":"ENCONTRAR PARTIDA","阻塞":"Bloqueado","邀请":"Convidar","添加":"Adicionar","邀请玩家":"Convidar jogadores","发送邀请":"Enviar convites","输入玩家名称":"Inserir nome de jogador","已邀请":"Convidados","你真的想移出{{summonerName}}吗？":"Você realmente deseja expulsar {{summonerName}}?","你已被移出了组房间":"Você foi expulso(a) do saguão de partida.","与你的好友一起玩，你就会获得组队奖励！更多好友组队意味着更多战利品，所以快去组队吧！":"Receba Recompensas de Grupo ao jogar com amigos! Quanto mais amigos, maior a recompensa, então monte sua equipe!","组队奖励":"RECOMPENSAS DE GRUPO","与你的好友一起玩来获得蓝色精萃奖励！更多好友组队意味着更多战利品！":"Receba recompensas de IP ao jogar com amigos. Quanto mais amigos, maior a recompensa!","快组队吧！":"MONTE SUA EQUIPE!","待定":"Pendente","已推荐":"Sugeridos","<span class='click-instruction'>点击以添加{{pointsAssignedOnClick}}点。</span><span class='click-instruction'>按住SHIFT键点击以添加1点。</span>":"<span class='click-instruction'>Clique para adicionar {{pointsAssignedOnClick}} pontos.</span><span class='click-instruction'>Shift+Clique para adicionar um ponto.</span>","<span class='click-instruction'>点击以添加1点。</span>":"<span class='click-instruction'>Clique para adicionar um ponto.</span>","下个点数":"Próximo ponto","无法在服务器上创建一个天赋页。也许是因为连接问题。":"Falha ao criar a Página de Talentos no servidor. Pode haver um problema de conexão.","添加新的天赋页":"Adicionar nova página","天赋页{{number}}":"Página de Talentos {{number}}","你确定想要删除该页吗？":"Quer mesmo excluir esta página?","删除天赋页":"Excluir página","编辑天赋页名称":"Editar nome da página","可用点数：{{number}}":"Pontos disponíveis: {{number}}","重置此天赋页的点数":"Zerar pontos nessa página","重置此天赋树的点数":"Zerar pontos nessa árvore","点击这里来保存你对天赋页的所有改动。":"Clique para salvar todas as alterações em suas páginas de Talentos.","由于连接失败，无法保存天赋页面。":"Falha ao salvar páginas de talento devido a problemas de rede.","保存":"SALVAR","你的天赋有尚未保存的改动。你想要保存吗？":"Você tem alterações não salvas em seus talentos. Deseja salvar?","需要在<span class='mastery-type'>{{type}}</span>至少分配{{ranks}}点":"Requer {{ranks}} pontos em <span class=\"mastery-type\">{{type}}</span>","需要在{{prereq}}至少分配{{ranks}}点":"Requer {{ranks}} colocações em {{prereq}}","剩余{{pointsLeft}}点数":"{{pointsLeft}} pts restantes","诡诈":"ASTÚCIA","凶猛":"FEROCIDADE","坚决":"DETERMINAÇÃO","诡诈系":"Astúcia","凶猛系":"Ferocidade","坚决系":"Determinação","房间":"Grupo","藏品":"Coleção","冠军杯赛":"Clash","电竞":"eSports","主页":"Início","经典模式":"Classic","战利品/圣堂":"Espólio","新闻":"Notícias","云顶之弈":"TFT","幸运商店":"Sua Loja","生涯":"Perfil","商城":"Loja","海斗第3季":"Desordem – Conjunto 3","更多信息":"MAIS INFORMAÇÕES","检测到必要更新":"Atualização Obrigatória Detectada","你的网络连接出问题了。如果你目前还没有连接上互联网，请先连接互联网。如果你已经连上互联网了但无法连接上《英雄联盟》，请查阅我们的<a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/201752664\" target='_blank'>客服信息</a>来看看是否有可行的解决方案。":"Detectamos um problema com sua conexão. Conecte-se para resolvê-lo. Se já estiver online, mas ainda não conseguir acessar o League of Legends, confira nossa <a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/201752664\" target='_blank'>página de suporte</a> para buscar soluções.","好的":"Tá bom","我们复原了一个较旧版本的《英雄联盟》。现在我们将尝试把它更新为最新版本。":"Restauramos uma versão mais antiga do cliente de League of Legends. Agora vamos tentar atualizá-la para a versão mais atual.","{{megabytes}} MB / {{kilobytes_per_second}} KB/秒":"{{megabytes}} MB a {{kilobytes_per_second}} KBps","在你安装目录下的文件权限正在阻止《英雄联盟》的安装。请按“OK”键，然后我们将尝试唤起你的操作系统的权限管理器。":"As permissões de arquivo em seu diretório de instalação estão impedindo a instalação do League. Pressione ‘OK' e tentaremos ativar o gerente de permissões do seu sistema operacional.","在连接至服务器时出问题了。请检查你的网络连接并重启补丁器。如果你的网络连接没有问题，请联系客服进行处理。":" Detectamos um problema na conexão ao servidor. Verifique sua conexão com a internet e reinicie o atualizador. Se sua conexão não for o problema, siga os passos de resolução de problemas em nossa <a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/201752664\" target='_blank'>página de suporte</a> para buscar possíveis soluções.","补丁器无法下载内容至你的硬盘。请检查下你的电脑，至少需要8GB的空闲容量和写入硬盘的必要权限才能安装《英雄联盟》。你可以联系我们的客服来获取更多有关这个错误的帮助。*注意*：点击“是”将关闭客户端。":"Não foi possível baixar a atualização no disco rígido. Esse erro geralmente ocorre por falta de espaço livre suficiente. Confira se seu computador tem ao menos 8 GB de espaço livre onde League of Legends foi instalado e se você tem as permissões necessárias para baixar arquivos. Para mais ajuda com esse erro, leia os passos de resolução de problemas <a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/202969434\" target='_blank'>aqui</a>. Obs.: clicar em ''OK'' fechará o cliente.","我们的服务器出故障了，并且在阻止你下载补丁内容。我们正在给服务器另一次机会。你可以<a href=\"http://lol.qq.com/act/a20150326dqpd/\" target='_blank'>点此</a>查看我们的服务器状态。":"Algo em nossos servidores impede que você faça a atualização. Vamos tentar novamente. Enquanto isto, você pode conferir o estado de nossos servidores <a href=\"http://status.leagueoflegends.com/?pt_BR#br\" target='_blank'>aqui</a>.","《英雄联盟》无法更新，因为你没有足够的硬盘空间。请至少释放{{Bytes}}空间然后重试。":"O League não consegue atualizar porque você não possui espaço em disco o suficiente. Por favor, libere pelo menos {{Bytes}} de espaço e tente novamente.","补丁更新失败，并且我们不确定原因是什么。请重启客户端并重试补丁更新。":"A atualização falhou e não sabemos o motivo. Por favor, reinicie o cliente para tentar atualizar de novo.","预计用时 {{number}}分钟":"Estimado: {{number}} min","好":"Tá bom","文件无法写入硬盘。请检查你是否有足够的磁盘空间和必要的许可。":"Falha ao escrever arquivo no disco. Por favor, verifique se há espaço livre suficiente e se você tem as permissões necessárias.","已修复档案：{{number}}":"Arquivos reparados: {{number}}","已扫描的文件：{{number}}":"Arquivos verificados: {{number}}","联盟客户端":"CLIENTE DE LEAGUE","游戏客户端":"CLIENTE DE JOGO","我们的服务器发生了些状况，导致你无法从服务器中获得更新文件。我们正在对服务器进行停机维护。在维护时，你可以在这里查看我们的服务器状态。":"Há algo de errado em nossos servidores, o que impede a sua atualização. Vamos tentar mais uma vez. Enquanto isso, confira a situação de nossos servidores aqui","这个错误也许由以下现网内部事故导致：":"Estes incidentes podem ter causado o erro:","我们已经将这个安装程序恢复至一个较早的《英雄联盟》版本、现在我们将尝试将它更新至最新版本。":"Restauramos esta instalação para uma versão mais antiga de League of Legends. Agora tentaremos atualizá-la para a versão mais recente.","正在应用版本补丁":"Aplicando atualizações","正在下载文件":"Baixando arquivos","正在提取所需的版本数据":"Buscando dados necessários de atualização","正在安装":"INSTALANDO","正在下载":"BAIXANDO","正在修复":"REPARANDO","正在扫描":"VERIFICANDO","修复":"Reparar","抱歉！我们在你的安装过程中检测到一些数据损坏。你想要修复受损的文件么？":"Desculpe! Detectamos uma possível corrupção de dados em sua instalação. Gostaria de reparar os arquivos afetados?","更新已完成下载。你必须重启客户端才能让更新生效。":"Uma atualização acaba de ser baixada. É necessário reiniciar o cliente antes que a atualização possa ser aplicada.","现在还不行":"Agora não","重新启动":"Reiniciar","第{{current_step}}步（共{{total_steps}}步）":"Etapa {{current_step}} de {{total_steps}}","更新失败，而我们不确定是什么原因。点击我们的客服页面{{support page}}来查找可能的解决方法。":"Falha na atualização, mas não sabemos o motivo. Confira nossa página de suporte {{support page}} para encontrar possíveis soluções.","正在更新……":"Atualizando...","在更新《英雄联盟》时出现了一个问题。我们正在复原《英雄联盟》的备份版本，并会在你重新启动后再次尝试":"Houve um problema ao atualizar League of Legends. Restauraremos para uma versão de backup antes de atualizar novamente assim que você reiniciar o atualizador.","游戏仍在进行中…":"Partida ainda em andamento...","全随机":"TODOS ALEATÓRIOS","跳过等待，直接开始下一局游戏。":"Pular espera por estatísticas","开始游戏":"Iniciar partida","可用":"Disponível","剩余1日":"1 dia restante","剩余{{days}}天":"{{days}} dias restantes","金币加成":"BÔNUS DE IP","网吧特权加成":"Bônus de lealdade","下一个奖励的进度":"PRÓXIMO BÔNUS EM","下一次重随的进度":"PRÓXIMA TROCA","没有激活加成":"Nenhum bônus ativo","剩余1胜":"1 vitória restante","剩余{{wins}}胜场":"{{wins}} vitórias restantes","双倍经验卡":"BÔNUS DE EXP","记分板":"PLACAR","下一个":"Próxima","失败":"DERROTA","第二名":"2º LUGAR","第1名":"1ª","蓝色精萃":"EA","全员战斗加成蓝色精萃已获得":"BÔNUS DE COMBATE RECEBIDO EM EA","蓝色精萃加成":"BÔNUS DE EA","当天首次胜利":"PRIMEIRA VITÓRIA DO DIA:","蓝色精萃获取":"EA RECEBIDA","特权加成蓝色精萃已获取":"BÔNUS DE EA RECEBIDO POR LEALDADE","统治战场蓝色精萃加成":"BÔNUS DE EA ODIN","小队奖励蓝色精萃加成已获得":"BÔNUS DE EA RECEBIDO POR RECOMPENSA DE EQUIPE","排队加成已获取":"BÔNUS DE FILA RECEBIDO","逃兵":"DESISTENTE","等级":"NÍVEL","此负场不作记录":"DERROTA EVITADA","加成点数":"Pontos adicionais","点数获取":"Pontos recebidos","总计：":"Total:","胜利":"VITÓRIA","点数":"PONTOS","总经验":"EXP TOTAL","特权加成经验已获取":"EXP RECEBIDA POR BÔNUS DE LEALDADE","经验已获取":"EXP RECEBIDA","还需{{points}}点即可到达{{level}}级":"{{points}} pontos para chegar ao nível {{level}}","重新连接":"Reconectar","游戏已经结束。你现在将返回主页。":"A partida acabou. Você voltará à página inicial.","您中途退出游戏，\n请重新连接。":"Você abandonou uma partida em andamento. Por favor, reconecte-se a ela.","添加好友":"Adicionar amigo","首页":"INÍCIO","再玩一次":"JOGAR NOVAMENTE","审核用的举报已经发送。感谢您的反馈。":"Uma denúncia foi enviada para revisão. Obrigado.","你已经用完了所有可用的奖励。":"Você utilizou todos as honras disponíveis.","确定":"OK","北":"Norte","队伍2":"EQUIPE 2","南":"Sul","队伍1":"EQUIPE 1","查看高级详情":"EXIBIR DETALHES AVANÇADOS","附加评论":"Comentários adicionais","给敌方放水":"Assistência ao inimigo","在这里输出评论":"Insira seu comentário aqui","不当的用户名":"Nome inadequado","故意送人头":"Morte proposital para o inimigo (''Intentional Feeding'')","挂机":"Abandono / Ociosidade (''AFK'')","消极态度":"Atitude negativa","不与团队进行沟通":"Não se comunicou com a equipe","攻击性的语言":"Linguajar ofensivo","举报":"DENUNCIAR","举报玩家":"Denunciar jogador","滥发信息":"Spam","无法举报这个玩家。请稍后再试。":"Não foi possível denunciar esse jogador. Tente novamente mais tarde.","玩家水平过低":"Jogador inexperiente","口头谩骂":"Abuso verbal","态度友好":"Amigável","乐于助人":"Prestativo","可敬的对手":"Oponente Honrado","无法称赞这个玩家。请稍后再试。":"Não foi possível elogiar esse jogador. Tente novamente mais tarde.","团队合作":"Trabalho em Equipe","助攻":"Assistências","英雄击杀":"Campeões abatidos","死亡":"Mortes","金币获取":"Ouro recebido","小兵击杀":"Tropas abatidas","该局总分":"Placar da série","召唤师等级：":"Nível de Invocador:","加成":"BÔNUS","你确定要从英雄选择阶段离开吗？":"Deseja mesmo sair da Seleção de Campeões?","一位玩家秒退了；你已经回到了房间。":"Um jogador abandonou a partida, você retornou ao saguão.","敌方队伍":"EQUIPE INIMIGA","你有{{rerolls}}个可用的英雄重随机会。":"Você tem {{rerolls}} Trocas de Campeão disponíveis","这个召唤师技能已被禁用。":"Esse feitiço foi desativado.","等级需求：{{level}}":"INDISPONÍVEL ATÉ O NV. {{level}}","{{actor}}正在和其他人交换":"{{actor}} está trocando com outra pessoa.","这个交换已被取消。":"Esta troca foi cancelada.","交换已被拒绝。":"Essa troca foi recusada.","还不能发出交换请求。请重试。":"A troca não pode ser solicitada. Por favor, tente novamente.","{{actor}}想要用{{entity1}}交换{{entity2}}。":"{{actor}} quer trocar {{entity1}} por {{entity2}}.","用{{entity1}}交换{{entity2}}。":"Trocar {{entity1}} por {{entity2}}.","正在等待{{actor}}回应你的交换请求……":"Aguardando {{actor}} aceitar sua troca.","己方队伍":"SUA EQUIPE","接受！":"Aceitar!","{{summonerName}}在英雄选择时离开。你已重新回到房间。":"{{summonerName}} abandonou durante a seleção de campeões. Você retornou ao saguão.","一名玩家在英雄选择时离开。你已重新回到房间。":"Um jogador abandonou durante a seleção de Campeões. Você retornou à fila.","对局已找到":"PARTIDA ENCONTRADA","准备战斗":"PREPARE-SE PARA A BATALHA","对局已接受":"PARTIDA ACEITA","对局已拒绝":"PARTIDA RECUSADA","正在等待其他玩家":"AGUARDANDO OUTROS JOGADORES","符文页{{number}}":"Página de Runas {{number}}","选择全部":"Selecionar tudo","都不选择":"Desselecionar","选择玩家来解除聊天黑名单，然后点击保存。":"Selecione os jogadores para desbloquear e clique em Salvar.","按字母顺序排列":"Ordem alfabética","开启语言过滤器":"Habilitar filtro de linguagem","启动链接警告":"Habilitar alerta de links","在线状态":"Status","好友列表的排列顺序：":"Ordenar lista de amigos por:","启动菜单动画":"Habilitar animações do menu","启动警告弹窗":"Habilitar popups de notificação","聊天黑名单":"Lista de bloqueados","聊天&好友":"Conversa e amigos","恢复默认设置":"Restaurar padrões","你确定要将所有选项重置为默认设置吗？":"Quer mesmo redefinir todas as suas opções para a configuração padrão?","综合":"Geral","键位绑定":"Teclas de atalho","选项":"Opções","全部恢复默认设置":"Restaurar tudo para o padrão","声音":"Sons","如果你的《英雄联盟》出了什么毛病，就点击下方的修复按钮来搞定它吧！警告：这个操作会耗费很长一段时间。":"Se houver algo de errado com League of Legends, clique no botão de Reparar abaixo para consertá-lo! Aviso: isto pode levar um bom tempo","你真的想要修复吗？它会耗费很长一段时间！":"Você realmente deseja reparar? Vai levar um bom tempo!","英雄选择界面的音乐音量":"Volume - música da seleção de campeões","启动英雄选择界面的音乐":"Habilitar música da Seleção de Campeões","启动登陆音乐":"Habilitar música do início de sessão","启动音效":"Habilitar efeitos sonoros","音效音量":"Volume - efeitos sonoros","关闭登录动画":"Desativar animações","关闭登录音效":"Desativar música","选择":"Selecionar","传说之证 边框":"Moldura de Prestígio","排位边框":"Moldura Ranqueada","展示往届排位旗帜":"Exibir bandeira de ranque anterior","无法保存。请稍后重试。":"Não foi possível salvar. Tente novamente mais tarde.","已选择":"Selecionada","当前不可用。":"Atualmente indisponível.","进行排位赛以解锁！":"Jogue partidas ranqueadas para habilitar!","保存中":"Salvando","选择一个召唤师图标":"Escolha um ícone de invocador","召唤师图标&边框选择器":"Ícone de invocador e seletor de moldura","无法保存你的选择。":"Falha ao salvar a seleção.","屏障":"Barreira","为你的英雄套上护盾，吸收115-455（取决于英雄等级）点伤害，持续2秒。":"Protege seu campeão de 115-455 de dano (dependendo do nível do campeão) por 2 segundos.","洞察":"Clarividência","将地图上任意一块区域暴露给你的队伍，持续5秒。":"Revela uma pequena área do mapa para sua equipe por 5 segundos.","清晰术":"Clareza","为你的英雄回复40%的最大法力值。也会为友军回复他们40%的最大法力值":"Restaura 40% da Mana máxima de seu Campeão. Também restaura 40% da Mana máxima de aliados.","净化":"Purificar","移除身上的所有限制效果和召唤师技能的减益效果，并且若在接下来的3秒里再次被施加限制效果时，新效果的持续时间会减少65%。":"Remove todos os desarmes e efeitos negativos de habilidades que afetam seu campeão e reduz a duração de desarmes recebidos em 65% por 3 segundos.","虚弱":"Exaustão","虚弱目标敌方英雄，降低目标英雄30%的移动速度和攻击速度，以及10护甲与魔法抗性，并且他们所造成的伤害减少40%，持续2.5秒。":"Exaure o campeão inimigo alvo, reduzindo sua Velocidade de Movimento e de Ataque em 30%, sua Armadura e Resistência Mágica em 10 e o dano que causa em 40% por 2,5 segundos.","闪现":"Flash","使英雄朝着你的指针所停的区域瞬间传送一小段距离。":"Teleport seu campeão em uma curta distância, na direção do seu cursor.","卫戍部队":"Fortificar","友方防御塔：提供巨量回复，持续8秒。敌方防御塔：降低伤害输出，持续8秒":"Torre aliada: Concede regeneração massiva por 8 segundos. Torre inimiga: Reduz o dano causado em 80% por 8 segundos.","幽灵疾步":"Fantasma","你的英雄在移动时会无视单位的碰撞体积，移动速度增加27%，持续10秒。":"Seu Campeão ignora colisão com unidades e tem 27% de Velocidade de Movimento adicional por 10 segundos.","治疗术":"Curar","为你和目标友军英雄回复95-345（取决于英雄等级）生命值，并为你和目标友军英雄提供30%移动速度加成，持续1秒。若目标近期已受到过其它治疗术的影响，则治疗术对目标产生的治疗效果减半。":"Restaura 90-345 de Vida (dependendo do nível do campeão) e concede 30% de Velocidade de Movimento por 1 segundo a você e ao campeão aliado alvo. Essa cura é cortada pela metade para unidades recentemente afetadas por outro Curar de Invocador.","引燃":"Incendiar","引燃是对单体敌方目标施放的持续性伤害技能，在5秒的持续时间里造成70-410（取决于英雄等级）真实伤害，获得目标的视野，并减少目标所受的治疗和回复效果。":"Incendeia o campeão inimigo alvo, causando 70-410 de Dano Verdadeiro (dependendo do nível do campeão) ao longo de 5 segundos, concede visão do alvo e reduz os efeitos de cura nele enquanto durar o efeito.","标记":"Marca","沿直线扔出一个雪球。如果雪球命中了一个敌人，那么这个敌人会被【标记】，并且你的英雄接下来可以快速突进到被【标记】的目标旁边。":"Arremessa uma bola de neve em linha reta. Se ela atingir um inimigo, ele fica marcado e seu campeão pode se deslocar rapidamente na direção dele na sequência.","魄罗投掷":"Arremesso de Poro","把一个魄罗投向你的敌人。如果它命中了一名敌人，那么你接下来就可以快速位移到被命中的敌人旁边。":"Arremessa um Poro em linha reta. Se ele atingir um inimigo, seu campeão pode se deslocar rapidamente na direção dele na sequência.","重生":"Ressuscitar","立刻在本队的召唤师平台上复活你的英雄，并暂时提升英雄的移动速度。":"Instantaneamente ressuscita seu campeão na Plataforma de Invocação da sua equipe e aumenta sua Velocidade de Movimento por um curto período de tempo.","惩戒":"Golpear","对目标史诗野怪、大型野怪或敌方小兵造成390-1000（取决于英雄等级）点真实伤害。":"Causa 390-1000 de Dano Verdadeiro (dependendo do nível do campeão) ao monstro grande ou épico alvo ou tropa inimiga.","传送":"Teleporte","在引导3.5秒后，将英雄传送到目标友方建筑物、小兵或守卫旁边。":"Após canalizar por 3,5 segundos, teleporta seu campeão para a estrutura, tropa ou sentinela aliada alvo.","护驾！":"Ao Rei!","快速位移到魄罗之王旁边。":"Desloca-se rapidamente para o lado do Rei Poro.","立刻领取":"INSTANTÂNEO","免费":"GRÁTIS","设置数量":"Selecione a quantidade","你没有足够的代币。":"Você não tem Emblemas suficientes.","输入至少{{minQuantity}}个。":"Inserir pelo menos {{minQuantity}}","你只能以{{minQuantity}}的倍数来购买。":"É possível comprar apenas múltiplos de {{minQuantity}}","愚人节快乐，乐子人们！来庆祝一下吧！ ":"Feliz Primeiro de Abril, colega! Vamos comemorar!","愚人节大军需要增援，而你就是那个完美的呆萌士兵！":"O exército de Primeiro de Abril precisa de reforços, e você é a pessoa perfeita!","冲啊！我的无-羽-伦比的派对礼品就给你拿去用来对抗混乱大军吧。":"À batalha! Minhas Lembrancinhas deliciosas são suas, use-as contra as forças do caos!","在非排位的【召唤师峡谷】，【极地大乱斗】和【人机对战】里找我。我们在黎明时兜风！":"Me encontre em partidas sem ranque de SR, ARAM e Coop. vs. IA. Avante até o amanhecer!","咕噜噜……(“你不玩吗？我可为你准备了很多愚人节惊喜……”)":"Prrr... (''Não quer brincar? Eu tenho tantas surpresas de Primeiro de Abril te esperando...'')","喵呜！ (“捏哈哈！有本事来抓我呀！”)":"Miau! (''Muahahaha! Pegue-me se for capaz!'')","咪嗷呜！ (“混乱就是我的地盘！一场喵灾在等待！”)":"Minhaaau! (''O caos é meu domínio! Uma gatástrofe aguarda!'')","企鹅 盖伦":"Garen Pingu","盒子猫 萨科":"Shaco Gatinho-Surpresa"};
  const patterns = [];
  try {
    window.__tr = createTextReplacer({ dict, patterns, collect: true });
  } catch (error) {
    /* 最坏情况: 什么都没发生, 客户端保持原样 */
  }
})();
