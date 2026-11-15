// monoshorts — 패널 로직
// 흐름: 구간 담기 → 세로 쇼츠 만들기 → (보고) 자막 크게

(function () {
  "use strict";

  var SM_VERSION = (window.SMUpdater && window.SMUpdater.localVersion()) || "1.0.4";

  function evalScript(script, cb) {
    if (window.__adobe_cep__ && window.__adobe_cep__.evalScript) {
      window.__adobe_cep__.evalScript(script, cb || function () {});
    } else {
      cb && cb("err:CEP 브릿지 없음");
    }
  }

  // 업데이트로 host.jsx가 바뀌었을 수 있으니, 패널이 열릴 때마다 최신 host.jsx를 다시 읽힌다
  try {
    var hostPath = extPath() + "/jsx/host.jsx";
    evalScript('$.evalFile("' + hostPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '")');
  } catch (eHost) {}

  var $ = function (id) { return document.getElementById(id); };
  var elSeqName = $("seqName"), elSeqRes = $("seqRes");
  var elSegHead = $("segHead"), elSegList = $("segList");
  var elStatus = $("status");
  var elBtnMake = $("btnMake");
  var elRngCapMul = $("rngCapMul"), elValCapMul = $("valCapMul");
  var elRngVPosY = $("rngVPosY"), elValVPosY = $("valVPosY");

  var workList = [];   // 담은 구간: {name, start, end, checked}
  var presetVal = "default";   // 모션 추적: slower|default|faster
  var reframeOn = true;        // 오토 프레임 적용 여부

  var PRESET_SEQ = ["slower", "default", "faster"];
  var PRESET_LABEL = { slower: "느리게 (안정적)", "default": "기본", faster: "빠르게" };

  // "확대 트랙" 입력 → 트랙별 배율 맵
  //   "2:110, 3:130" → {"2":110,"3":130}     (트랙마다 다른 배율)
  //   "2,3"          → {"2":def,"3":def}      (콜론 없으면 슬라이더 배율)
  //   ""             → {"*":def}              (전체를 슬라이더 배율로)
  // def = 슬라이더(자막 배율) 값
  function parseCapMap(str, defPct) {
    var map = {}, any = false;
    String(str || "").split(",").forEach(function (tk) {
      tk = (tk + "").replace(/\s/g, "");
      if (!tk) return;
      var parts = tk.split(":");
      var tn = parseInt(parts[0], 10);
      if (!(tn >= 2 && tn <= 30)) return;
      var pct = (parts.length > 1) ? parseInt(parts[1], 10) : defPct;
      if (!(pct > 0)) pct = defPct;
      map["" + tn] = pct;
      any = true;
    });
    if (!any) map["*"] = defPct;
    return map;
  }

  // 상태 창은 '오류만 보이기' — err일 때만 표시하고 그 외(성공·진행·안내)엔 숨긴다.
  // force=true면 오류가 아니어도 보여줌 (줄바꿈 결과·업데이트 안내 등)
  function setStatus(msg, cls, force) {
    elStatus.textContent = msg;
    elStatus.className = "status" + (cls ? " " + cls : "");
    elStatus.style.display = (cls === "err" || force) ? "block" : "none";
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function updateLabels() {
    elValCapMul.textContent = elRngCapMul.value + "%";
    elValVPosY.textContent = (parseInt(elRngVPosY.value, 10) / 100).toFixed(2);
  }

  // ---- 담은 구간 목록 ----
  function updateHead() { elSegHead.textContent = "담은 구간 " + workList.length + "개"; }

  function renderList() {
    elSegList.innerHTML = "";
    updateHead();
    if (!workList.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.innerHTML = "아직 담은 구간이 없습니다.<br><br>" +
        "타임라인에서 <b>In(I) / Out(O)</b>으로 구간을 잡고 위 <b>＋ 이 구간 담기</b>를 누르세요. " +
        "여러 번 반복하면 쇼츠를 여러 개 담을 수 있습니다.";
      elSegList.appendChild(e);
      return;
    }
    workList.forEach(function (seg, i) {
      var row = document.createElement("div"); row.className = "seg";
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = seg.checked !== false;
      cb.addEventListener("change", function () { seg.checked = cb.checked; });
      var info = document.createElement("div"); info.className = "info";
      var name = document.createElement("div");
      name.className = "segname-fixed"; name.textContent = seg.name;   // 고정 라벨(수정 불가)
      var m = document.createElement("div"); m.className = "m";
      m.textContent = fmtDur(seg.start) + " ~ " + fmtDur(seg.end) + "  (" + fmtDur(seg.end - seg.start) + ")";
      info.appendChild(name); info.appendChild(m);
      var del = document.createElement("span");
      del.className = "del"; del.textContent = "✕"; del.title = "이 구간 빼기";
      del.addEventListener("click", function () { workList.splice(i, 1); renderList(); });
      row.appendChild(cb); row.appendChild(info); row.appendChild(del);
      elSegList.appendChild(row);
    });
  }

  // 다음 쇼츠 번호 = (프로젝트의 [쇼츠] Short N 시퀀스 + 현재 목록)의 최댓값 + 1
  // → 목록이 리셋돼도(만든 시퀀스가 남아있으니) 번호가 이어지고, 절대 줄지 않음
  function nextShortNum(cb) {
    evalScript("SM_listShorts()", function (lres) {
      var maxN = 0;
      try {
        var lj = JSON.parse(lres);
        (lj.items || []).forEach(function (enc) {
          var m = decodeURIComponent(enc).match(/Short\s+(\d+)/i);
          if (m) { var n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
        });
      } catch (e) {}
      workList.forEach(function (s) {
        var m = String(s.name).match(/Short\s+(\d+)/i);
        if (m) { var n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
      });
      cb(maxN + 1);
    });
  }

  // ---- 현재 In/Out 담기 ----
  function addInOut() {
    evalScript("SM_getInOut()", function (res) {
      var r = null;
      try { r = JSON.parse(res); } catch (e) { setStatus("In/Out 읽기 실패: " + res, "err"); return; }
      if (!r.ok) {
        if (r.reason === "no-seq") setStatus("활성 시퀀스가 없습니다. 시퀀스를 여세요.", "err");
        else if (r.reason === "no-inout" || r.reason === "invalid")
          setStatus("In/Out이 지정되지 않았습니다. 타임라인에서 I(시작)·O(끝)를 먼저 찍어주세요.", "err");
        else setStatus("실패: " + (r.reason || res), "err");
        return;
      }
      nextShortNum(function (num) {
        workList.push({ name: "Short " + num, start: r["in"], end: r.out, checked: true });
        renderList();
        setStatus("구간 담김: Short " + num + "  (" + fmtDur(r["in"]) + " ~ " + fmtDur(r.out) + ")", "ok");
      });
    });
  }

  // ---- 마커에서 불러오기 ----
  function importFromMarkers() {
    evalScript("SM_getInfo()", function (res) {
      var info = null;
      try { info = JSON.parse(res); } catch (e) { setStatus("마커 읽기 실패: " + res, "err"); return; }
      if (!info.ok || !info.segments || !info.segments.length) {
        setStatus("불러올 마커 구간이 없습니다. (범위 마커 또는 점 마커 쌍 필요)", "err"); return;
      }
      info.segments.forEach(function (s) {
        workList.push({ name: s.name, start: s.start, end: s.end, checked: true });
      });
      renderList();
      setStatus("마커에서 " + info.segments.length + "개 구간을 불러왔습니다.", "ok");
    });
  }

  // ---- 시퀀스 헤더 ----
  function loadSeqHeader() {
    evalScript("SM_getInfo()", function (res) {
      var info = null;
      try { info = JSON.parse(res); } catch (e) { return; }
      if (!info || !info.ok) {
        if (info && info.reason === "no-seq") {
          elSeqName.textContent = "열린 시퀀스 없음";
          elSeqRes.textContent = "타임라인에서 시퀀스를 여세요";
          elSeqRes.className = "res warn";
        }
        return;
      }
      elSeqName.textContent = info.name; elSeqName.title = info.name;
      var r2 = info.w + "×" + info.h;
      if (info.w && info.h && info.w > info.h) { elSeqRes.textContent = r2 + " · 가로 ✓"; elSeqRes.className = "res"; }
      else if (info.w && info.h) { elSeqRes.textContent = r2 + " · 가로 영상이 아닌 것 같아요"; elSeqRes.className = "res warn"; }
      else { elSeqRes.textContent = "해상도 확인 불가"; elSeqRes.className = "res warn"; }
    });
  }

  // ---- 세로 쇼츠 만들기 (확인 → 실행) ----
  // 버튼을 누르면 먼저 "정말 만들까요?" 확인 UI를 띄우고, 예를 눌러야 실제로 만든다.
  function askMakeShorts() {
    var chosen = workList.filter(function (s) { return s.checked !== false; });
    if (!chosen.length) { setStatus("체크된 구간이 없습니다. 만들 구간을 담고 체크하세요.", "err"); return; }
    $("btnMake").style.display = "none";
    $("confirmMake").style.display = "block";
    setStatus("담은 구간 " + chosen.length + "개를 쇼츠로 만들까요? 아래에서 예/아니오를 선택하세요.");
  }
  function cancelMakeShorts() {
    $("confirmMake").style.display = "none";
    $("btnMake").style.display = "block";
    setStatus("취소했습니다. 담은 구간은 그대로 있어요.");
  }
  function confirmMakeShorts() {
    $("confirmMake").style.display = "none";
    $("btnMake").style.display = "block";
    makeShorts();
  }

  function makeShorts() {
    var chosen = workList.filter(function (s) { return s.checked !== false; });
    if (!chosen.length) { setStatus("체크된 구간이 없습니다. 만들 구간을 담고 체크하세요.", "err"); return; }

    var arNum = parseInt($("arNum").value, 10) || 22;
    var arDen = parseInt($("arDen").value, 10) || 25;
    var opt = {
      method: "autoreframe",
      preset: presetVal,   // slower|default|faster
      arNum: arNum, arDen: arDen,
      vPosY: parseInt(elRngVPosY.value, 10) / 100,   // 영상 세로 위치 (0.5=중앙, 클수록 아래)
      capMap: parseCapMap($("txtCapTracks").value, parseInt(elRngCapMul.value, 10)),   // 트랙별 자막 배율 (예: {"2":110,"3":130})
      noReframe: !reframeOn,    // 오토 프레임 비적용 여부
      titleMogrt: SETTINGS.titleMogrt || "",    // 윗줄 제목 템플릿 — 쇼츠 만들 때 V2에 자동 배치
      titleMogrt2: SETTINGS.titleMogrt2 || "",  // 아랫줄 제목 템플릿 — V3에 자동 배치
      segments: chosen.map(function (s) { return { name: s.name, start: s.start, end: s.end }; }),
      wrap: null   // 자동 줄바꿈은 끔 — 익스포트 탭에서 직접 적용
    };
    setStatus("Auto Reframe 쇼츠 " + chosen.length + "개 만드는 중…\n(분석에 구간당 수십 초 걸릴 수 있어요. 기다려주세요)");
    elBtnMake.disabled = true;

    var arg = JSON.stringify(opt).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    evalScript("SM_makeShorts('" + arg + "')", function (res) {
      elBtnMake.disabled = false;
      if (res && res.indexOf("done:") === 0) {
        var body = res.substring(5);
        var count = body.split("|")[0];
        var logs = body.substring(body.indexOf("|") + 1).split(" || ").join("\n");
        // 방금 만든(체크된) 구간은 목록에서 제거 — 체크 안 한 구간은 남김
        workList = workList.filter(function (s) { return s.checked === false; });
        renderList();
        // 자동 줄바꿈한 것들은 되돌리기 목록에 저장
        if (opt.wrap) evalScript("SM_takeLastWrapUndo()", function (u) { pushUndo("쇼츠 만들기 자동 줄바꿈", u); });
        var hasTitle = !!(SETTINGS.titleMogrt || SETTINGS.titleMogrt2);
        var titleWhere = SETTINGS.titleMogrt2 ? "V2·V3" : "V2";
        var doneMsg = "완료 " + count + "개 생성.\n" + logs +
          "\n\n프로젝트 패널에 [쇼츠] 시퀀스가 생겼습니다.\n담은 구간 목록은 비웠습니다." +
          (hasTitle ? ("\n제목 템플릿을 각 쇼츠 " + titleWhere + "에 올렸어요. 글자는 화면에서 더블클릭해 직접 입력하세요.") : "");
        // 제목 템플릿은 importMGT가 비동기 → 잠시 뒤 새 클립을 찾아 길이 맞춤
        var showIt = !!opt.wrap;   // 자동 줄바꿈을 켰으면 결과(몇 개 줄바꿈했는지)를 보여줌
        if (hasTitle) {
          setTimeout(function () { doFlush(8, function () { setStatus(doneMsg, "ok", showIt); }); }, 700);
        } else {
          setStatus(doneMsg, "ok", showIt);
        }
      } else {
        setStatus("실패: " + res, "err");
      }
    });
  }

  // ---- 자막 일괄 크게 ----
  function enlargeCaptions() {
    var map = parseCapMap($("txtCapTracks").value, parseInt(elRngCapMul.value, 10));
    setStatus("자막 크기 조정 중…");
    evalScript("SM_enlargeCaptions(" + JSON.stringify(map) + ")", function (res) {
      if (res && res.indexOf("ok") === 0)
        setStatus(res.substring(3) + "\n(반영이 안 보이면 시퀀스 탭을 다시 눌러보세요)", "ok");
      else setStatus("실패: " + res, "err");
    });
  }

  // ---- 이벤트 연결 ----
  $("btnRefresh").addEventListener("click", loadSeqHeader);
  $("btnAddInOut").addEventListener("click", addInOut);
  $("btnClearList").addEventListener("click", function () { workList = []; renderList(); setStatus("목록을 비웠습니다."); });
  elBtnMake.addEventListener("click", askMakeShorts);
  $("btnMakeYes").addEventListener("click", confirmMakeShorts);
  $("btnMakeNo").addEventListener("click", cancelMakeShorts);
  $("btnEnlargeCap").addEventListener("click", enlargeCaptions);
  $("btnPreset").addEventListener("click", function () {
    var i = PRESET_SEQ.indexOf(presetVal);
    presetVal = PRESET_SEQ[(i + 1) % PRESET_SEQ.length];
    $("btnPreset").textContent = PRESET_LABEL[presetVal];
  });
  // 오토 프레임 적용/비적용 토글
  function updateReframeBtn() {
    var b = $("btnReframe");
    if (!b) return;
    b.textContent = reframeOn ? "적용" : "비적용";
    b.className = reframeOn ? "" : "danger";
    var p = $("btnPreset"); if (p) p.disabled = !reframeOn;   // 비적용이면 모션 추적 비활성
  }
  $("btnReframe").addEventListener("click", function () {
    reframeOn = !reframeOn;
    updateReframeBtn();
  });
  updateReframeBtn();
  elRngCapMul.addEventListener("input", updateLabels);
  elRngVPosY.addEventListener("input", updateLabels);

  // ---- 탭 전환 ---- (구형 CEP 엔진에서도 확실하게: display를 직접 제어)
  var TABS = { make: "paneMake", "export": "paneExport", settings: "paneSettings" };
  var TABBTN = { make: "tabMake", "export": "tabExport", settings: "tabSettings" };
  function showTab(which) {
    for (var k in TABS) {
      var on = (k === which);
      $(TABBTN[k]).className = "tab" + (on ? " active" : "");
      $(TABS[k]).style.display = on ? "flex" : "none";
    }
  }
  $("tabMake").addEventListener("click", function () { showTab("make"); });
  $("tabExport").addEventListener("click", function () { showTab("export"); });
  $("tabSettings").addEventListener("click", function () { showTab("settings"); });

  // ========== 익스포트 탭 ==========
  var bottomImagePath = "";   // 첨부 이미지 경로
  var bottomImageW = 0, bottomImageH = 0;   // 첨부 이미지 원본 픽셀 크기
  var SETTINGS = { titleMogrt: "", titleMogrt2: "" };

  // 이미지 크기 읽기 — 브라우저(CEP는 Chromium)로 로드해 naturalWidth/Height (모든 포맷)
  // 실패 시 헤더 파서로 폴백. 비동기 → 콜백(w,h)
  function fileUrl(path) {
    return "file://" + String(path).split("/").map(function (seg) {
      return seg ? encodeURIComponent(seg) : seg;
    }).join("/");
  }
  function loadImageSize(path, cb) {
    var done = false;
    function finish(w, h) { if (done) return; done = true; cb(w || 0, h || 0); }
    try {
      var img = new Image();
      img.onload = function () { finish(img.naturalWidth, img.naturalHeight); };
      img.onerror = function () { var s = getImageSize(path); finish(s.w, s.h); };
      img.src = fileUrl(path);
      setTimeout(function () { if (!done) { var s = getImageSize(path); finish(s.w, s.h); } }, 2500);
    } catch (e) { var s = getImageSize(path); finish(s.w, s.h); }
  }

  // 이미지 파일 헤더에서 원본 픽셀 크기 읽기 (PNG/JPEG/GIF) — 폴백용
  function getImageSize(path) {
    try {
      var fs = require("fs");
      var buf = fs.readFileSync(path);
      if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };   // PNG
      if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
        return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };     // GIF
      if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {      // JPEG
        var off = 2;
        while (off < buf.length - 8) {
          if (buf[off] !== 0xFF) { off++; continue; }
          var mk = buf[off + 1];
          if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC)
            return { w: buf.readUInt16BE(off + 7), h: buf.readUInt16BE(off + 5) };
          if (mk === 0xD8 || mk === 0xD9 || (mk >= 0xD0 && mk <= 0xD7)) { off += 2; continue; }
          off += 2 + buf.readUInt16BE(off + 2);
        }
      }
    } catch (e) {}
    return { w: 0, h: 0 };
  }

  // 확장 폴더 경로 (설정 파일 저장용)
  function extPath() {
    try {
      var p = decodeURIComponent(window.__adobe_cep__.getSystemPath("extension"));
      return p.replace(/^file:\/\//, "");
    } catch (e) { return ""; }
  }
  function loadSettings() {
    try {
      var fs = require("fs"); var p = extPath() + "/sm-settings.json";
      if (fs.existsSync(p)) SETTINGS = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {}
    // 제목 템플릿은 templates 폴더를 기준으로 자동 인식 — 파일명 순서대로 윗줄=V2, 아랫줄=V3
    var fsX = null;
    try { fsX = require("fs"); } catch (e0) {}
    var tpls = autoTitleTpls();
    SETTINGS.titleMogrt  = tpls[0] || "";
    SETTINGS.titleMogrt2 = tpls[1] || "";
    // 출력 프리셋: 저장된 게 유효하면 유지, 아니면 내장 .epr 자동 사용
    var presetOk = false;
    if (SETTINGS.exportPreset && fsX) { try { presetOk = fsX.existsSync(SETTINGS.exportPreset); } catch (e3) {} }
    if (!presetOk) SETTINGS.exportPreset = autoExportPreset() || "";
    updateTitleTplLabel();
    updateExportLabels();
    restoreBottomImage();   // 저장해둔 하단 이미지 복원
  }
  // 저장된 하단 이미지 경로가 있으면 복원 (파일이 남아있을 때만)
  function restoreBottomImage() {
    var p = SETTINGS.bottomImage;
    if (!p) return;
    var ok = false;
    try { ok = require("fs").existsSync(p); } catch (e) {}
    if (!ok) { SETTINGS.bottomImage = ""; return; }
    bottomImagePath = p; bottomImageW = 0; bottomImageH = 0;
    var el = $("bottomImgPath");
    if (el) el.textContent = "이미지: " + baseName(p) + "  (크기 읽는 중…)";
    loadImageSize(p, function (w, h) {
      bottomImageW = w; bottomImageH = h;
      if (el) el.textContent = "이미지: " + baseName(p) + (w ? "  (" + w + "×" + h + ")" : "  (크기 인식 실패 — 근사 배치)");
    });
  }
  // presets 폴더에서 첫 번째 .epr 경로 반환 (내장 출력 프리셋 자동 감지)
  function autoExportPreset() {
    try {
      var fs = require("fs"); var dir = extPath() + "/presets";
      if (!fs.existsSync(dir)) return "";
      var files = fs.readdirSync(dir);
      for (var i = 0; i < files.length; i++) { if (/\.epr$/i.test(files[i])) return dir + "/" + files[i]; }
    } catch (e) {}
    return "";
  }
  function updateExportLabels() {
    var pe = $("presetPath");
    if (pe) pe.textContent = SETTINGS.exportPreset ? ("프리셋: " + baseName(SETTINGS.exportPreset) + " (소스 일치)") : "프리셋 미지정";
    var fe = $("exportFolderPath");
    if (fe) fe.textContent = SETTINGS.exportFolder ? ("폴더: " + SETTINGS.exportFolder) : "폴더: 바탕화면 (기본)";
  }
  function saveSettings() {
    try { var fs = require("fs"); fs.writeFileSync(extPath() + "/sm-settings.json", JSON.stringify(SETTINGS)); } catch (e) {}
  }
  // templates 폴더의 .mogrt들을 파일명 오름차순으로 반환 (윗줄=[0], 아랫줄=[1])
  function autoTitleTpls() {
    var out = [];
    try {
      var fs = require("fs"); var dir = extPath() + "/templates";
      if (!fs.existsSync(dir)) return out;
      var files = fs.readdirSync(dir).filter(function (f) { return /\.mogrt$/i.test(f); });
      files.sort();
      for (var i = 0; i < files.length; i++) out.push(dir + "/" + files[i]);
    } catch (e) {}
    return out;
  }
  function autoTitleTpl() { return autoTitleTpls()[0] || ""; }
  function baseName(p) { return String(p || "").split(/[\/\\]/).pop(); }
  function updateTitleTplLabel() {
    var el = $("titleTplPath");   // 요소가 있을 때만 (UI에서 제거됨)
    if (el) el.textContent = SETTINGS.titleMogrt ? ("템플릿: " + baseName(SETTINGS.titleMogrt)) : "템플릿 미지정";
  }

  function pickBottomImage() {
    var hint = encodeURIComponent("하단 이미지 선택");
    evalScript("SM_pickFile('" + hint + "')", function (res) {
      if (!res) return;
      if (res.indexOf("err:") === 0) { setStatus("선택 실패: " + res, "err"); return; }
      bottomImagePath = decodeURIComponent(res);
      bottomImageW = 0; bottomImageH = 0;
      SETTINGS.bottomImage = bottomImagePath; saveSettings();   // 다음에도 유지되게 저장
      $("bottomImgPath").textContent = "이미지: " + baseName(bottomImagePath) + "  (크기 읽는 중…)";
      loadImageSize(bottomImagePath, function (w, h) {
        bottomImageW = w; bottomImageH = h;
        $("bottomImgPath").textContent = "이미지: " + baseName(bottomImagePath) + (w ? "  (" + w + "×" + h + ")" : "  (크기 인식 실패 — 근사 배치)");
      });
      setStatus("하단 이미지 첨부: " + baseName(bottomImagePath) + " (하단 여백에 맞게 축소됩니다)", "ok");
    });
  }
  function clearBottomImage() {
    bottomImagePath = ""; bottomImageW = 0; bottomImageH = 0;
    SETTINGS.bottomImage = ""; saveSettings();
    $("bottomImgPath").textContent = "첨부된 이미지 없음";
  }
  // ---- 최종 파일 익스포트 ----
  function pickPreset() {
    var hint = encodeURIComponent("출력 프리셋(.epr) 선택");
    evalScript("SM_pickFile('" + hint + "')", function (res) {
      if (!res) return;
      if (res.indexOf("err:") === 0) { setStatus("선택 실패: " + res, "err"); return; }
      SETTINGS.exportPreset = decodeURIComponent(res); saveSettings(); updateExportLabels();
      setStatus("출력 프리셋 지정: " + baseName(SETTINGS.exportPreset), "ok");
    });
  }
  function pickFolder() {
    evalScript("SM_pickFolder()", function (res) {
      if (!res) return;
      if (res.indexOf("err:") === 0) { setStatus("선택 실패: " + res, "err"); return; }
      SETTINGS.exportFolder = decodeURIComponent(res); saveSettings(); updateExportLabels();
      setStatus("저장 폴더 지정: " + SETTINGS.exportFolder, "ok");
    });
  }
  function doExport() {
    if (!SETTINGS.exportPreset) { setStatus("내장 출력 프리셋(.epr)을 찾지 못했습니다. presets 폴더 확인이 필요합니다.", "err"); return; }
    setStatus("최종 파일 익스포트 중…\n(완료까지 프리미어가 잠시 멈춥니다. 기다려주세요)");
    $("btnExport").disabled = true;
    var opt = { preset: SETTINGS.exportPreset, folder: SETTINGS.exportFolder || "" };   // 폴더 미지정 시 바탕화면
    var arg = encodeURIComponent(JSON.stringify(opt)).replace(/'/g, "%27");
    evalScript("SM_exportSequence('" + arg + "')", function (res) {
      $("btnExport").disabled = false;
      if (res && res.indexOf("ok:") === 0) setStatus("익스포트 완료 ✓\n" + res.substring(3), "ok");
      else setStatus("익스포트 실패: " + (res ? res.replace(/^err:/, "") : "응답 없음"), "err");
    });
  }
  // [쇼츠]로 만든 모든 시퀀스를 한 번에 파일 출력
  function doExportAll() {
    if (!SETTINGS.exportPreset) { setStatus("내장 출력 프리셋(.epr)을 찾지 못했습니다. presets 폴더 확인이 필요합니다.", "err"); return; }
    setStatus("[쇼츠] 전체 최종 파일 익스포트 중…\n(시퀀스 수만큼 오래 걸리고, 그동안 프리미어가 멈춥니다. 기다려주세요)");
    $("btnExport").disabled = true; $("btnExportAll").disabled = true;
    var opt = { preset: SETTINGS.exportPreset, folder: SETTINGS.exportFolder || "" };
    var arg = encodeURIComponent(JSON.stringify(opt)).replace(/'/g, "%27");
    evalScript("SM_exportSequenceAll('" + arg + "')", function (res) {
      $("btnExport").disabled = false; $("btnExportAll").disabled = false;
      if (res && res.indexOf("okall:") === 0) {
        var body = res.substring(6);
        var count = body.split("|")[0];
        var logs = body.substring(body.indexOf("|") + 1).split(" || ").join("\n");
        setStatus("전체 익스포트 완료 " + count + "\n" + logs, "ok");
      } else {
        setStatus("전체 익스포트 실패: " + (res ? res.replace(/^err:/, "") : "응답 없음"), "err");
      }
    });
  }
  // 지연 재시도로 mogrt 텍스트 채우기 (남은 게 있으면 최대 tries번 재시도)
  function doFlush(tries, done) {
    evalScript("SM_flushFills()", function (fres) {
      var m = (fres || "").match(/flush:(\d+)\/(\d+)/);
      var remain = m ? (parseInt(m[2], 10) - parseInt(m[1], 10)) : 0;
      if (remain > 0 && tries > 1) {
        setTimeout(function () { doFlush(tries - 1, done); }, 700);
      } else {
        done(fres);
      }
    });
  }
  // 현재 열려 있는(작업 중인) 시퀀스에 하단 이미지 적용 (제목은 쇼츠 만들 때 이미 올라감)
  function applyExport() {
    if (!bottomImagePath) {
      setStatus("첨부된 하단 이미지가 없습니다. 먼저 이미지를 첨부하세요.", "err"); return;
    }
    var opt = {
      bottomImage: bottomImagePath,
      bottomImageW: bottomImageW, bottomImageH: bottomImageH
    };
    setStatus("작업 중인 시퀀스에 하단 이미지 적용 중…");
    $("btnApplyExport").disabled = true;
    var arg = encodeURIComponent(JSON.stringify(opt)).replace(/'/g, "%27");
    evalScript("SM_applyExport('" + arg + "')", function (res) {
      $("btnApplyExport").disabled = false;
      if (res && res.indexOf("err:") === 0) {
        setStatus("실패: " + res.substring(4), "err");
        return;
      }
      setStatus("하단 이미지 적용 완료.\n" + res, "ok");
      try { require("fs").writeFileSync(extPath() + "/last-export-log.txt", res); } catch (e) {}
    });
  }
  // [쇼츠]로 만든 모든 시퀀스에 하단 이미지 한 번에 적용
  function applyExportAll() {
    if (!bottomImagePath) {
      setStatus("첨부된 하단 이미지가 없습니다. 먼저 이미지를 첨부하세요.", "err"); return;
    }
    var opt = {
      bottomImage: bottomImagePath,
      bottomImageW: bottomImageW, bottomImageH: bottomImageH
    };
    setStatus("[쇼츠] 전체 시퀀스에 하단 이미지 적용 중…\n(시퀀스 수만큼 시간이 걸릴 수 있어요)");
    $("btnApplyExport").disabled = true; $("btnApplyAll").disabled = true;
    var arg = encodeURIComponent(JSON.stringify(opt)).replace(/'/g, "%27");
    evalScript("SM_applyExportAll('" + arg + "')", function (res) {
      $("btnApplyExport").disabled = false; $("btnApplyAll").disabled = false;
      if (res && res.indexOf("okall:") === 0) {
        var body = res.substring(6);
        var count = body.split("|")[0];
        var logs = body.substring(body.indexOf("|") + 1).split(" || ").join("\n");
        setStatus("전체 적용 완료 " + count + "\n" + logs, "ok");
        try { require("fs").writeFileSync(extPath() + "/last-export-log.txt", res); } catch (e) {}
      } else {
        setStatus("실패: " + (res ? res.replace(/^err:/, "") : "응답 없음"), "err");
      }
    });
  }

  $("btnPickImage").addEventListener("click", pickBottomImage);
  $("btnClearImage").addEventListener("click", clearBottomImage);
  $("btnApplyExport").addEventListener("click", applyExport);
  $("btnApplyAll").addEventListener("click", applyExportAll);
  $("btnPickPreset").addEventListener("click", pickPreset);
  $("btnPickFolder").addEventListener("click", pickFolder);
  $("btnExport").addEventListener("click", doExport);
  $("btnExportAll").addEventListener("click", doExportAll);

  // ========== [1.0.4] 자막 줄바꿈 ==========
  function wrapCfg() {
    var w = SETTINGS.wrap || {};
    return {
      safe: (w.safe >= 60 && w.safe <= 100) ? w.safe : 90,
      maxChars: (w.maxChars > 0) ? w.maxChars : 0
    };
  }
  function syncWrapUI() {
    var c = wrapCfg();
    $("rngWrapSafe").value = c.safe;
    $("valWrapSafe").textContent = c.safe + "%";
    $("numWrapChars").value = c.maxChars;
  }
  function saveWrapUI() {
    SETTINGS.wrap = {
      safe: parseInt($("rngWrapSafe").value, 10) || 90,
      maxChars: Math.max(0, parseInt($("numWrapChars").value, 10) || 0)
    };
    $("valWrapSafe").textContent = SETTINGS.wrap.safe + "%";
    saveSettings();
  }
  // 되돌리기 기록: wrap-undo.json = [{time, label, items:[...]}, ...] (최근 30개)
  function undoPath() { return extPath() + "/wrap-undo.json"; }
  function readUndo() {
    try { var fs = require("fs"); if (fs.existsSync(undoPath())) return JSON.parse(fs.readFileSync(undoPath(), "utf8")); } catch (e) {}
    return [];
  }
  function writeUndo(arr) { try { require("fs").writeFileSync(undoPath(), JSON.stringify(arr.slice(-30))); } catch (e) {} }
  function pushUndo(label, itemsStr) {
    var items = [];
    try { items = typeof itemsStr === "string" ? JSON.parse(itemsStr) : (itemsStr || []); } catch (e) { return; }
    if (!items.length) return;
    var arr = readUndo();
    arr.push({ time: new Date().toLocaleString(), label: label, items: items });
    writeUndo(arr);
  }
  function runWrap(fnName, label) {
    saveWrapUI();
    var c = wrapCfg();
    var arg = JSON.stringify({ safe: c.safe, maxChars: c.maxChars });
    setStatus("자막 줄바꿈 중…", "", true);
    evalScript(fnName + "('" + arg + "')", function (res) {
      var r = null;
      try { r = JSON.parse(res); } catch (e) { setStatus("줄바꿈 실패: " + res, "err"); return; }
      if (!r.ok) { setStatus("줄바꿈 실패: " + r.reason, "err"); return; }
      pushUndo(label + " · " + r.seq, r.undo);
      var log = decodeURIComponent(r.log || "");
      var head = "줄바꿈 " + r.changed + "개 적용" + (r.skipped ? (", 건너뜀 " + r.skipped + "개") : "") +
        "  (" + (r.seqCount ? (r.seqCount + "개 시퀀스, ") : "") + "자막 " + r.clips + "개 검토)";
      if (r.clips === 0) head = "자막(텍스트) 클립을 찾지 못했어요.";
      // 건너뛴 이유는 첫 줄에 바로 보이게
      var why = (log.match(/⚠ 건너뛴 이유: ([^\n]*)/) || [])[1];
      if (why) head += "\n⚠ 건너뛴 이유: " + why;
      var full = head + (log ? ("\n\n" + log) : "") + (r.changed ? "\n\n마음에 안 들면 '마지막 줄바꿈 되돌리기'를 누르세요." : "");
      try { require("fs").writeFileSync(extPath() + "/wrap-log.txt", new Date().toLocaleString() + "  v" + SM_VERSION + "\n" + full); } catch (eW) {}   // 진단용 기록
      setStatus(full, r.changed ? "ok" : "err", true);
    });
  }
  function undoWrap() {
    var arr = readUndo();
    if (!arr.length) { setStatus("되돌릴 줄바꿈 기록이 없습니다.", "err"); return; }
    var last = arr[arr.length - 1];
    var enc = encodeURIComponent(JSON.stringify(last.items)).replace(/'/g, "%27");
    setStatus("되돌리는 중… (" + last.label + ")", "", true);
    evalScript("SM_restoreCaptions('" + enc + "')", function (res) {
      if (res && res.indexOf("ok:") === 0) {
        arr.pop(); writeUndo(arr);
        setStatus("되돌리기 완료: " + last.label + " — " + res.substring(3) + " 복원" +
          (arr.length ? ("\n(남은 되돌리기 기록 " + arr.length + "개)") : ""), "ok", true);
      } else setStatus("되돌리기 실패: " + res, "err");
    });
  }
  $("rngWrapSafe").addEventListener("input", function () { $("valWrapSafe").textContent = $("rngWrapSafe").value + "%"; });
  $("rngWrapSafe").addEventListener("change", saveWrapUI);
  $("numWrapChars").addEventListener("change", saveWrapUI);
  $("btnWrapCur").addEventListener("click", function () { runWrap("SM_wrapCurrent", "작업 중인 것 줄바꿈"); });
  $("btnWrapAll").addEventListener("click", function () { runWrap("SM_wrapAll", "전체 줄바꿈"); });
  $("btnWrapUndo").addEventListener("click", undoWrap);

  // ========== 업데이트 · 버전 ==========
  var upd = window.SMUpdater;
  function showVer() {
    var v = upd ? upd.localVersion() : SM_VERSION;
    var pin = upd && upd.pinned();
    $("updVer").textContent = "v" + v + (pin ? "  (버전 고정 · 자동 업데이트 멈춤)" : "");
    var vl = $("verLabel"); if (vl) vl.textContent = "v" + v;
  }
  function afterInstall(r) {
    try { sessionStorage.setItem("monoshorts.justUpdated", JSON.stringify(r)); } catch (e) {}
    if (r.needsRestart) {
      setStatus("v" + r.version + " 설치 완료. 이번 변경은 프리미어를 껐다 켜야 적용됩니다.", "ok", true);
    } else {
      setStatus("v" + r.version + " 설치 완료. 패널을 다시 불러옵니다…", "ok", true);
      setTimeout(function () { location.reload(); }, 1200);
    }
  }
  function checkUpdate(manual) {
    if (!upd) { if (manual) setStatus("업데이트 기능을 불러오지 못했습니다.", "err"); return; }
    upd.check(function (msg) { setStatus(msg, "", true); }, manual).then(function (r) {
      if (r.status === "pinned") return;   // 버전 고정 중 — 자동 확인 안 함
      if (r.status === "none") { if (manual) setStatus("최신 버전입니다 (v" + r.version + ")", "ok", true); showVer(); return; }
      afterInstall(r);
    }).catch(function (e) {
      if (manual) setStatus("업데이트 확인 실패: " + e.message, "err");
    });
  }
  function loadVersionList() {
    if (!upd) return;
    var sel = $("selVersion");
    upd.listVersions().then(function (list) {
      sel.innerHTML = "";
      if (!list.length) { sel.innerHTML = '<option value="">(아직 올라간 버전 없음)</option>'; return; }
      list.forEach(function (tag, i) {
        var o = document.createElement("option");
        o.value = tag; o.textContent = tag + (i === 0 ? " (최신)" : "") + (tag.replace(/^v/, "") === upd.localVersion() ? " ← 지금" : "");
        sel.appendChild(o);
      });
      sel.setAttribute("data-latest", list[0]);
    }).catch(function (e) {
      sel.innerHTML = '<option value="">목록을 못 불러옴 (' + e.message + ')</option>';
    });
  }
  function installSelected() {
    var sel = $("selVersion"), tag = sel.value;
    if (!tag) { setStatus("설치할 버전을 고르세요.", "err"); return; }
    var isLatest = (tag === sel.getAttribute("data-latest"));
    setStatus(tag + " 설치 중…", "", true);
    upd.installVersion(tag, isLatest, function (msg) { setStatus(msg, "", true); })
      .then(afterInstall)
      .catch(function (e) { setStatus("설치 실패: " + e.message, "err"); });
  }
  if (upd) {
    $("chkAutoUpd").checked = upd.isAuto();
    $("chkAutoUpd").addEventListener("change", function () { upd.setAuto($("chkAutoUpd").checked); });
    $("btnCheckUpd").addEventListener("click", function () { checkUpdate(true); });
    $("btnInstallVer").addEventListener("click", installSelected);
    $("tabSettings").addEventListener("click", function () { if (!$("selVersion").getAttribute("data-latest")) loadVersionList(); });
  }

  var elVer = $("verLabel");
  if (elVer) elVer.textContent = "v" + SM_VERSION;   // 패널에 버전 표시

  loadSettings();
  showTab("make");   // 초기 상태 정규화
  syncWrapUI();
  showVer();
  // 방금 업데이트됐으면 알림
  try {
    var ju = sessionStorage.getItem("monoshorts.justUpdated");
    if (ju) { sessionStorage.removeItem("monoshorts.justUpdated"); var jr = JSON.parse(ju);
      setTimeout(function () { setStatus("v" + jr.version + " 적용됨" + (jr.notes ? (" — " + jr.notes) : ""), "ok", true); }, 300); }
  } catch (eJ) {}
  // 패널 열 때 자동 업데이트 확인 (버전 고정 중이면 건너뜀)
  if (upd && upd.isAuto()) setTimeout(function () { checkUpdate(false); }, 1500);

  // ---- 시작 ----
  updateLabels();
  renderList();
  loadSeqHeader();
  setStatus("monoshorts " + SM_VERSION + " · 타임라인에서 In/Out 잡고 '이 구간 담기'");
})();

