// monoshorts — Premiere Pro 호스트 스크립트 (ExtendScript / ES3)
// 가로(1920x1080) 시퀀스를 마커 구간별로 세로(1080x1920) 쇼츠로 변환한다.
//
// 핵심 원리
//   1) 활성 시퀀스에서 "범위 마커"(또는 점 마커 쌍)를 읽어 구간 목록을 만든다
//   2) 구간마다 1080x1920 세로 시퀀스를 새로 만든다
//   3) 원본 시퀀스 자체를 "중첩(nest) 클립"으로 넣는다 (자막·효과 그대로 따라옴)
//   4) 중첩 클립을 상단으로 리프레임(모션 크기·위치)하고 하단은 여백으로 남긴다
//
// ※ ExtendScript는 구형 자바스크립트(ES3)라 let/const/화살표함수 못 씀. var만 사용.
// ※ 모든 함수는 성공/실패를 "문자열"로 돌려준다 — 패널이 그 문자열로 진단을 표시한다.

// ---------- 유틸 ----------

// 문자열 안전화 (JSON에 넣을 때 따옴표/역슬래시 처리)
function SM_esc(s) {
    s = String(s);
    s = s.replace(/\\/g, "\\\\");
    s = s.replace(/"/g, '\\"');
    s = s.replace(/[\r\n\t]/g, " ");
    return s;
}

// 초 -> Time 객체
function SM_time(sec) {
    var t = new Time();
    t.seconds = sec;
    return t;
}

// 이름으로 프로젝트 아이템(시퀀스 포함) 재귀 탐색
function SM_findItemByName(bin, name) {
    for (var i = 0; i < bin.children.numItems; i++) {
        var it = bin.children[i];
        if (it.type === ProjectItemType.BIN) {
            var found = SM_findItemByName(it, name);
            if (found) return found;
        } else if (String(it.name) === String(name)) {
            return it;
        }
    }
    return null;
}

// 활성 시퀀스의 ProjectItem 얻기 (중첩 삽입에 필요)
function SM_activeSeqProjectItem() {
    var seq = app.project.activeSequence;
    if (!seq) return null;
    // 최신 버전: sequence.projectItem 이 바로 있음
    try { if (seq.projectItem) return seq.projectItem; } catch (e) {}
    // 폴백: 이름으로 프로젝트 패널에서 탐색
    return SM_findItemByName(app.project.rootItem, seq.name);
}

// ---------- 1) 시퀀스 + 마커 정보 읽기 ----------

// 활성 시퀀스 정보와 마커 구간을 JSON 문자열로 반환
// 반환 예: {"ok":true,"name":"...","w":1920,"h":1080,"markerMode":"range",
//           "segments":[{"name":"인트로","start":0.0,"end":12.5,"dur":12.5}, ...]}
function SM_getInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"ok":false,"reason":"no-seq"}';

        // 해상도 읽기 (버전에 따라 getSettings 지원)
        var w = 0, h = 0;
        try {
            var st = seq.getSettings();
            w = parseInt(st.videoFrameWidth, 10) || 0;
            h = parseInt(st.videoFrameHeight, 10) || 0;
        } catch (eS) {}
        // getSettings 없으면 프레임사이즈 폴백
        if (!w || !h) {
            try {
                w = seq.frameSizeHorizontal || 0;
                h = seq.frameSizeVertical || 0;
            } catch (eF) {}
        }

        // 프레임레이트 계산 (CSV 타임코드 → 초 변환에 필요)
        var fps = 0;
        try {
            var tb = parseFloat(seq.timebase);   // 프레임당 ticks
            if (tb > 0) {
                var rawFps = 254016000000 / tb;
                // 흔한 프레임레이트로 스냅
                var commons = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
                fps = rawFps;
                for (var ci = 0; ci < commons.length; ci++) {
                    if (Math.abs(rawFps - commons[ci]) < 0.05) { fps = commons[ci]; break; }
                }
                fps = Math.round(fps * 1000) / 1000;
            }
        } catch (eFps) {}

        // 마커 수집
        var mk = seq.markers;
        var raw = [];
        var m = mk.getFirstMarker();
        while (m) {
            raw.push({
                name: String(m.name || ""),
                start: m.start.seconds,
                end: m.end.seconds,
                comments: String(m.comments || "")
            });
            m = mk.getNextMarker(m);
        }
        // 시작 시간순 정렬
        raw.sort(function (a, b) { return a.start - b.start; });

        // 범위 마커가 하나라도 있으면 range 모드, 아니면 점 마커 쌍(pair) 모드
        var hasRange = false;
        for (var i = 0; i < raw.length; i++) {
            if (raw[i].end - raw[i].start > 0.05) { hasRange = true; break; }
        }

        var segs = [];
        var mode = "";
        var n;
        if (hasRange) {
            mode = "range";
            for (n = 0; n < raw.length; n++) {
                if (raw[n].end - raw[n].start > 0.05) {
                    segs.push({
                        name: raw[n].name || raw[n].comments || ("Short " + (segs.length + 1)),
                        start: raw[n].start,
                        end: raw[n].end
                    });
                }
            }
        } else if (raw.length >= 2) {
            mode = "pair";
            for (n = 0; n + 1 < raw.length; n += 2) {
                segs.push({
                    name: raw[n].name || raw[n].comments || ("Short " + (segs.length + 1)),
                    start: raw[n].start,
                    end: raw[n + 1].start
                });
            }
        } else {
            mode = "none";
        }

        // JSON 조립 (수동 — ExtendScript엔 JSON.stringify가 없을 수 있음)
        var parts = [];
        for (var k = 0; k < segs.length; k++) {
            var dur = segs[k].end - segs[k].start;
            parts.push('{"name":"' + SM_esc(segs[k].name) +
                '","start":' + segs[k].start.toFixed(3) +
                ',"end":' + segs[k].end.toFixed(3) +
                ',"dur":' + dur.toFixed(3) + '}');
        }
        return '{"ok":true,"name":"' + SM_esc(seq.name) +
            '","w":' + w + ',"h":' + h + ',"fps":' + (fps || 0) +
            ',"markerCount":' + raw.length +
            ',"markerMode":"' + mode +
            '","segments":[' + parts.join(",") + "]}";
    } catch (e) {
        return '{"ok":false,"reason":"' + SM_esc(e.toString()) + '"}';
    }
}

// ---------- 2) 세로 시퀀스 생성 + 리프레임 ----------

// 모션 컴포넌트에서 위치/크기 속성을 찾아 설정
// scalePct: 숫자(퍼센트), posY: 0~1 정규화 세로위치 (0.5=중앙)
function SM_reframeClip(clip, scalePct, posY) {
    if (!clip) return "no-clip";
    var comps = clip.components;
    var motion = null;
    for (var i = 0; i < comps.numItems; i++) {
        var dn = String(comps[i].displayName);
        if (dn === "Motion" || dn === "모션") { motion = comps[i]; break; }
    }
    if (!motion) return "no-motion";

    var props = motion.properties;
    var scaleP = null, posP = null;
    for (var j = 0; j < props.numItems; j++) {
        var pn = String(props[j].displayName);
        if (pn === "Scale" || pn === "크기" || pn === "비율") scaleP = props[j];
        if (pn === "Position" || pn === "위치") posP = props[j];
    }
    var done = "";
    try { if (scaleP) { scaleP.setValue(scalePct, true); done += "scale "; } } catch (eS) {}
    try { if (posP) { posP.setValue([0.5, posY], true); done += "pos "; } } catch (eP) {}
    return "ok:" + done;
}

// 시퀀스의 In/Out 지점을 구간으로 설정 (createSubsequence가 이 구간을 씀)
function SM_setSeqInOut(seq, aSec, bSec) {
    var ok = false;
    try { seq.setInPoint(SM_time(aSec)); seq.setOutPoint(SM_time(bSec)); ok = true; } catch (e1) {}
    if (!ok) { try { seq.setInPoint(aSec); seq.setOutPoint(bSec); ok = true; } catch (e2) {} }
    if (!ok) { try { seq.setInPointAsTime(SM_time(aSec)); seq.setOutPointAsTime(SM_time(bSec)); ok = true; } catch (e3) {} }
    return ok;
}

// SRT 자막 파일을 시퀀스에 캡션 트랙으로 임포트
function SM_importCaptions(seq, srtPath) {
    try {
        var f = new File(srtPath);
        if (!f.exists) return "srt없음";
        var ok = app.project.importFiles([f.fsName], true, app.project.rootItem, false);
        if (!ok) return "srt임포트실패";
        var base = f.name;
        var capItem = SM_findItemByName(app.project.rootItem, base);
        if (!capItem) capItem = SM_findItemByName(app.project.rootItem, base.replace(/\.srt$/i, ""));
        if (!capItem) return "srt아이템못찾음";
        try { seq.createCaptionTrack(capItem, "0"); return "캡션OK"; }
        catch (e1) {
            try { seq.createCaptionTrack(capItem, 0); return "캡션OK2"; }
            catch (e2) { return "createCaptionTrack실패:" + e2; }
        }
    } catch (e) { return "err:" + e; }
}

// 원본 자막 트랙(V2 이상) 숨기기 — 독립 복사본에서만 하므로 원본 프로젝트엔 영향 없음
function SM_hideCaptionTracks(seq) {
    var n = 0;
    try {
        var vt = seq.videoTracks;
        for (var t = 1; t < vt.numTracks; t++) {   // V2 이상
            var muted = false;
            try { vt[t].setMute(1); muted = true; n++; } catch (eM) {}
            if (!muted) {
                try {
                    var clips = vt[t].clips;
                    for (var c = 0; c < clips.numItems; c++) {
                        try { clips[c].disabled = true; n++; } catch (eD) {}
                    }
                } catch (eC) {}
            }
        }
    } catch (e) {}
    return n;
}

// 한 자막 클립의 Text 크기를 "절대값"(pct%)으로 설정 — 올리든 내리든 그 값이 됨
// (Auto Reframe이 Motion/Vector Motion으로 위치를 잡으므로 Motion은 건드리지 않음)
function SM_scaleCaptionClip(clip, pct) {
    try {
        var comps = clip.components;
        for (var i = 0; i < comps.numItems; i++) {
            var dn = String(comps[i].displayName);
            if (dn === "Text" || dn === "텍스트") {
                var props = comps[i].properties;
                for (var j = 0; j < props.numItems; j++) {
                    var pn = String(props[j].displayName);
                    if (pn === "Scale" || pn === "크기") {
                        try { props[j].setValue(pct, true); return "text"; } catch (e1) {}
                    }
                }
            }
        }
    } catch (e) {}
    return "no";
}

// 트랙별 배율 맵(capMap)에서 특정 트랙(V번호)에 적용할 퍼센트를 구함
//   capMap 예: {"2":110,"3":130}  → V2=110%, V3=130%
//              {"*":120}          → V2 이상 전체 120%
//   맵에 없고 "*"도 없으면 null(=그 트랙은 안 건드림)
function SM_pctForTrack(capMap, vnum) {
    if (!capMap) return null;
    var key = "" + vnum;
    if (capMap[key] !== null && capMap[key] !== undefined) return parseFloat(capMap[key]);
    if (capMap["*"] !== null && capMap["*"] !== undefined) return parseFloat(capMap["*"]);
    return null;
}
// 배율 맵을 사람이 읽는 문구로 (예: "V2 110%, V3 130%")
function SM_capDesc(capMap) {
    var arr = [];
    for (var k in capMap) {
        if (!capMap.hasOwnProperty(k)) continue;
        if (k === "*") arr.push("전체 " + capMap[k] + "%");
        else arr.push("V" + k + " " + capMap[k] + "%");
    }
    return arr.length ? arr.join(", ") : "(없음)";
}
// 주어진 시퀀스의 자막을 트랙별 배율(capMap)로 절대 크기 설정 (내부용)
// pct가 null이거나 100이면 그 트랙은 그대로 둔다(원본 유지).
function SM_enlargeCaptionsOfSeq(seq, capMap) {
    var nText = 0, fail = 0;
    try {
        var vt = seq.videoTracks;
        for (var t = 1; t < vt.numTracks; t++) {   // V2 이상
            var pct = SM_pctForTrack(capMap, t + 1);
            if (pct === null || pct === 100 || isNaN(pct)) continue;
            var clips = vt[t].clips;
            for (var c = 0; c < clips.numItems; c++) {
                var r = SM_scaleCaptionClip(clips[c], pct);
                if (r === "text") nText++; else fail++;
            }
        }
    } catch (e) {}
    return { text: nText, fail: fail };
}

// 현재 열린 시퀀스의 자막 확대 (버튼용 — [쇼츠] 시퀀스에서만). capMap: 트랙별 배율 맵
function SM_enlargeCaptions(capMap) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "err:열린 시퀀스가 없습니다";
        if (String(seq.name).indexOf("[쇼츠]") !== 0) {
            return "err:이 기능은 '쇼츠 만들기'로 만든 [쇼츠] 시퀀스에서만 쓸 수 있어요. 원본이 망가지지 않게 막았습니다. (현재 열린 시퀀스: " + seq.name + ")";
        }
        var r = SM_enlargeCaptionsOfSeq(seq, capMap);
        return "ok:자막 " + SM_capDesc(capMap) + " — " + r.text + "개 적용, 실패 " + r.fail;
    } catch (e) { return "err:" + e; }
}

// [방식 A] 트랙 통째로 가져와 변형: createSubsequence로 모든 트랙을 독립 복사한 뒤
//          V1(영상)은 상단, V2+(자막/그래픽)는 자막 크기·위치로 개별 변형
function SM_makeOne_tracks(shortName, seg, srcSeq, vSettings, wantW, wantH, vScale, vPosY, cScale, cPosY, capMode, hideOrig, srtPath) {
    if (!SM_setSeqInOut(srcSeq, seg.start, seg.end))
        return "err:시퀀스 In/Out 설정 불가";
    var sub = null;
    try { sub = srcSeq.createSubsequence(true); }
    catch (e1) { try { sub = srcSeq.createSubsequence(); } catch (e2) { return "err:createSubsequence " + e2; } }
    if (!sub) { try { sub = app.project.activeSequence; } catch (e3) {} }
    if (!sub) return "err:서브시퀀스 참조 없음";
    // 세로 설정 적용
    try {
        if (vSettings) sub.setSettings(vSettings);
        else {
            var ns = sub.getSettings();
            ns.videoFrameWidth = wantW; ns.videoFrameHeight = wantH;
            try { ns.pixelAspectRatio = 1.0; } catch (e) {}
            sub.setSettings(ns);
        }
    } catch (eS) { return "err:세로설정 " + eS; }
    try { sub.name = shortName; } catch (eN) {}
    // 트랙별 변형
    var cntV = 0, cntC = 0, numV = 0;
    try {
        var vt = sub.videoTracks;
        numV = vt.numTracks;
        // 영상·자막 모든 클립에 "같은" 변형 적용 → 자막이 영상에 붙어서 함께 움직임
        for (var t = 0; t < numV; t++) {
            var isVideo = (t === 0);
            var clips = vt[t].clips;
            for (var c = 0; c < clips.numItems; c++) {
                SM_reframeClip(clips[c], vScale, vPosY);
                if (isVideo) cntV++; else cntC++;
            }
        }
    } catch (eT) { return "err:트랙변형 " + eT; }
    return "ok:트랙(V" + numV + " 영상" + cntV + "/자막" + cntC + ")";
}

// 임시 시퀀스들을 모아둘 빈 반환 (없으면 생성)
function SM_getTmpBin() {
    var root = app.project.rootItem;
    var NAME = "monoshorts 소스(건들지마세요)";  // "monoshorts 소스(건들지마세요)"
    for (var i = 0; i < root.children.numItems; i++) {
        var it = root.children[i];
        if (it.type === ProjectItemType.BIN && String(it.name) === NAME) return it;
    }
    try { return root.createBin(NAME); } catch (e) { return null; }
}

// 중간 산출물(~reframe / ~tmp) 시퀀스를 정리 폴더로 옮기고, 열린 타임라인 탭도 닫는다.
// (중첩 소스라 삭제는 못 하지만, QE로 탭만 닫음 — 시퀀스 자체는 유지)
function SM_sweepIntermediates() {
    var moved = 0, closed = 0;
    var bin = null;
    try { bin = SM_getTmpBin(); } catch (eB) {}
    // 중간 시퀀스 이름 수집
    var names = [];
    try {
        var seqs = app.project.sequences;
        for (var i = 0; i < seqs.numSequences; i++) {
            var nm = String(seqs[i].name);
            if (nm.indexOf("~reframe") >= 0 || nm.indexOf("~tmp") >= 0) names.push(nm);
        }
    } catch (eL) {}
    // 정리 폴더로 이동
    for (var k = 0; k < names.length; k++) {
        try {
            var s = SM_findSeqByName(names[k]);
            if (s && bin && s.projectItem) { s.projectItem.moveBin(bin); moved++; }
        } catch (eM) {}
    }
    // 열린 탭 닫기 (QE): 해당 시퀀스를 활성화한 뒤 탭 닫기
    try {
        app.enableQE();
        for (var q = 0; q < names.length; q++) {
            try {
                var sq = SM_findSeqByName(names[q]);
                if (!sq) continue;
                try { app.project.openSequence(sq.sequenceID); } catch (eO) {}
                var qeSeq = qe.project.getActiveSequence();
                if (qeSeq && qeSeq.close) { qeSeq.close(); closed++; }
            } catch (eC) {}
        }
    } catch (eQE) {}
    return moved + "이동/" + closed + "탭닫음";
}

// [방식 C · 메인] Auto Reframe → 1080x1920 쇼츠 시퀀스로 출력
//   ① 구간 16:9 분리 → ② autoReframe(예 22:25) → ③ 1080x1920 시퀀스에 중첩·폭맞춤·중앙
function SM_makeOne_autoreframe(shortName, seg, srcSeq, preset, arNum, arDen, vSettings, wantW, wantH, capMap, vPosY, titleMogrt, titleMogrt2, noReframe, wrapOpt) {
    if (typeof vPosY !== "number" || vPosY <= 0) vPosY = 0.5;
    if (!SM_setSeqInOut(srcSeq, seg.start, seg.end))
        return "err:시퀀스 In/Out 설정 불가";

    // ① 구간 16:9 서브시퀀스
    var sub16 = null;
    try { sub16 = srcSeq.createSubsequence(true); }
    catch (e1) { try { sub16 = srcSeq.createSubsequence(); } catch (e2) { return "err:createSubsequence " + e2; } }
    if (!sub16) { try { sub16 = app.project.activeSequence; } catch (e3) {} }
    if (!sub16) return "err:서브시퀀스 참조 없음";
    try { sub16.name = shortName + " ~tmp16"; } catch (eN0) {}

    // ② Auto Reframe (비적용 시 건너뜀) → 세로 배치용 소스 시퀀스 확보
    var reName, reframed = null, reW = 0, reH = 0, capInfo = "";
    if (noReframe) {
        // 오토 프레임 비적용: 잘라낸 16:9 서브시퀀스를 그대로 소스로 사용(분석 없음)
        reName = sub16.name;
        try { var ss0 = sub16.getSettings(); reW = parseInt(ss0.videoFrameWidth, 10); reH = parseInt(ss0.videoFrameHeight, 10); } catch (eRS0) {}
        if (capMap) {
            var cr0 = SM_enlargeCaptionsOfSeq(sub16, capMap);
            capInfo = " 자막(" + SM_capDesc(capMap) + ",적용" + cr0.text + "/실패" + cr0.fail + ")";
        }
    } else {
        reName = shortName + " ~reframe";
        try { reframed = sub16.autoReframeSequence(arNum || 22, arDen || 25, preset || "default", reName, false); }
        catch (eAR) { return "err:autoReframe " + eAR; }
        if (!reframed) return "err:autoReframe 결과 없음";
        try { var rs = reframed.getSettings(); reW = parseInt(rs.videoFrameWidth, 10); reH = parseInt(rs.videoFrameHeight, 10); } catch (eRS) {}
        if (capMap) {
            var cr = SM_enlargeCaptionsOfSeq(reframed, capMap);
            capInfo = " 자막(" + SM_capDesc(capMap) + ",적용" + cr.text + "/실패" + cr.fail + ")";
        }
        // [1.0.4] 자막 자동 줄바꿈 (크기 조정 뒤에 해야 넘침을 정확히 판단)
        if (wrapOpt) {
            try {
                var wr = SM_wrapCaptionsOfSeq(reframed, SM_wrapOpt(wrapOpt), SM_WRAP_LAST_UNDO);
                capInfo += " 줄바꿈" + wr.changed + "개" + (wr.skipped ? ("(건너뜀" + wr.skipped + ")") : "");
            } catch (eW) { capInfo += " 줄바꿈오류:" + eW; }
        }
    }

    // ③ 소스 시퀀스 projectItem 확보
    var reItem = null;
    var srcSeqForItem = noReframe ? sub16 : reframed;
    try { if (srcSeqForItem.projectItem) reItem = srcSeqForItem.projectItem; } catch (eP) {}
    if (!reItem) reItem = SM_findItemByName(app.project.rootItem, reName);
    if (!reItem) return "err:소스 아이템 못찾음";

    // ④ 1080x1920 최종 시퀀스 생성 — 대화상자 없이 createNewSequenceFromClips 우선
    var finalSeq = null, madeBy = "";
    try {
        finalSeq = app.project.createNewSequenceFromClips(shortName, [reItem], app.project.rootItem);
        if (finalSeq) madeBy = "fromClips";
    } catch (eCF) { finalSeq = null; }
    if (!finalSeq) {
        // 폴백: createNewSequence (대화상자가 뜰 수 있음) + 중첩 삽입
        try {
            var uid = "SMF" + (new Date()).getTime() + "_" + Math.floor(Math.random() * 100000);
            app.project.createNewSequence(shortName, uid);
            finalSeq = app.project.activeSequence;
            try { finalSeq.videoTracks[0].insertClip(reItem, SM_time(0)); }
            catch (eIns1) { finalSeq.insertClip(reItem, SM_time(0), 0, 0); }
            madeBy = "newSeq";
        } catch (eNew) { return "err:최종시퀀스 생성 " + eNew; }
    }
    if (!finalSeq) return "err:최종시퀀스 참조 없음";

    // ⑤ 1080x1920 프레임설정
    try {
        if (vSettings) finalSeq.setSettings(vSettings);
        else {
            var ns = finalSeq.getSettings();
            ns.videoFrameWidth = wantW; ns.videoFrameHeight = wantH;
            try { ns.pixelAspectRatio = 1.0; } catch (ePar) {}
            finalSeq.setSettings(ns);
        }
    } catch (eSet) { return "err:최종설정 " + eSet; }

    // ⑥ 리프레임 클립 폭 맞춰 스케일 + 중앙
    var scalePct = (reW > 0) ? (wantW / reW * 100) : 100;
    var clip = null;
    try { clip = finalSeq.videoTracks[0].clips[0]; } catch (eC) {}
    var rf = SM_reframeClip(clip, scalePct, vPosY);

    // ⑥-b 제목 템플릿 자동 배치 — 윗줄=V2(트랙 index1), 아랫줄=V3(트랙 index2)
    //     (글자는 사용자가 화면에서 직접 입력. 위치·크기는 템플릿 원본 그대로)
    var titleInfo = "";
    try {
        if (titleMogrt || titleMogrt2) {
            var need = titleMogrt2 ? 3 : 2;
            SM_ensureVideoTracks(finalSeq, need);   // V2·V3 확보
            var endSecT = SM_seqEndSeconds(finalSeq);
            if (titleMogrt) {
                var tf1 = new File(titleMogrt);
                titleInfo += tf1.exists ? (" · 제목1(V2):" + SM_placeMogrt(finalSeq, titleMogrt, 1, endSecT)) : " · 제목1:템플릿없음";
            }
            if (titleMogrt2) {
                var tf2 = new File(titleMogrt2);
                titleInfo += tf2.exists ? (" · 제목2(V3):" + SM_placeMogrt(finalSeq, titleMogrt2, 2, endSecT)) : " · 제목2:템플릿없음";
            }
        }
    } catch (eT) { titleInfo = " · 제목:" + eT; }

    // ⑤ 중간 산출물 정리
    if (noReframe) {
        // sub16이 최종의 중첩 소스라 삭제 불가 → 정리 폴더로 이동
        try { var bin0 = SM_getTmpBin(); if (bin0 && sub16.projectItem) sub16.projectItem.moveBin(bin0); } catch (eMv0) {}
    } else {
        try { if (app.project.deleteSequence) app.project.deleteSequence(sub16); } catch (eDel) {}
        try { var bin = SM_getTmpBin(); if (bin && reframed.projectItem) reframed.projectItem.moveBin(bin); } catch (eMove) {}
    }

    var modeInfo = noReframe ? "리프레임OFF" : "리프레임";
    return "ok:쇼츠(1080x1920 [" + madeBy + "] · " + modeInfo + " " + reW + "x" + reH + " → 폭맞춤 " + Math.round(scalePct) + "% " + rf + capInfo + titleInfo + ")";
}

// [방식 B] 폴백 — 원본 시퀀스를 중첩(nest) 클립으로 넣고 상단 리프레임 (자막 변형 불가)
function SM_makeOne_nest(shortName, seg, srcItem, vSettings, wantW, wantH, vScale, vPosY) {
    if (!srcItem) return "err:원본 projectItem 없음";
    var newSeq = null;
    try {
        var uid = "SM" + (new Date()).getTime() + "_" + Math.floor(Math.random() * 100000);
        app.project.createNewSequence(shortName, uid);
        newSeq = app.project.activeSequence;
    } catch (eNew) { return "err:시퀀스 생성 " + eNew; }
    if (!newSeq) return "err:새 시퀀스 참조 없음";
    try {
        if (vSettings) newSeq.setSettings(vSettings);
        else {
            var ns = newSeq.getSettings();
            ns.videoFrameWidth = wantW; ns.videoFrameHeight = wantH;
            try { ns.pixelAspectRatio = 1.0; } catch (e) {}
            newSeq.setSettings(ns);
        }
    } catch (eSet) {}
    try {
        try { srcItem.setInPoint(SM_time(seg.start), 4); } catch (eIn) { srcItem.setInPoint(SM_time(seg.start)); }
        try { srcItem.setOutPoint(SM_time(seg.end), 4); } catch (eOut) { srcItem.setOutPoint(SM_time(seg.end)); }
    } catch (eIO) {}
    try { newSeq.videoTracks[0].insertClip(srcItem, SM_time(0)); }
    catch (eIns1) {
        try { newSeq.insertClip(srcItem, SM_time(0), 0, 0); }
        catch (eIns2) { return "err:중첩 삽입 " + eIns2; }
    }
    var clip = null;
    try { clip = newSeq.videoTracks[0].clips[0]; } catch (e) {}
    var rf = SM_reframeClip(clip, vScale, vPosY);
    try { srcItem.clearInPoint(); srcItem.clearOutPoint(); } catch (e) {}
    return "ok:nest(" + rf + ")";
}

// 옵션 JSON을 받아 선택 구간들을 세로 쇼츠로 만든다
// opt 예: {"scale":56,"posY":0.27,"capScale":50,"capPosY":0.72,"method":"tracks","segments":[...]}
function SM_makeShorts(optJson) {
    try {
        var opt = {};
        try { opt = eval("(" + optJson + ")"); } catch (ePar) { return "err:옵션 파싱 실패 " + ePar; }
        var vScale = (typeof opt.scale === "number") ? opt.scale : 56;
        var vPosY = (typeof opt.posY === "number") ? opt.posY : 0.27;
        var cScale = (typeof opt.capScale === "number") ? opt.capScale : 50;
        var cPosY = (typeof opt.capPosY === "number") ? opt.capPosY : 0.72;
        var capMode = opt.capMode || "keep";   // "keep"(그대로) | "manual"(수동조정)
        var hideOrig = (opt.hideOrig === true); // 원본 자막 트랙 숨기기
        var wantW = opt.w || 1080;
        var wantH = opt.h || 1920;
        var method = opt.method || "tracks";   // "tracks"(트랙 변형) | "nest"(중첩)

        var srcSeq = app.project.activeSequence;
        if (!srcSeq) return "err:활성 시퀀스 없음";
        var srcName = srcSeq.name;
        var srcItem = SM_activeSeqProjectItem();

        // 세로 설정(원본 프레임레이트 상속 + 1080x1920)
        var vSettings = null;
        try {
            vSettings = srcSeq.getSettings();
            vSettings.videoFrameWidth = wantW;
            vSettings.videoFrameHeight = wantH;
            try { vSettings.pixelAspectRatio = 1.0; } catch (ePAR) {}
        } catch (eGS) { vSettings = null; }

        // 구간 목록
        var segsToMake = [];
        if (opt.segments && opt.segments.length) {
            for (var s = 0; s < opt.segments.length; s++) {
                var sg = opt.segments[s];
                if (sg && (sg.end - sg.start) > 0.05)
                    segsToMake.push({ name: sg.name || ("Short " + (s + 1)), start: sg.start, end: sg.end, srtPath: sg.srtPath || "" });
            }
        } else {
            var info = eval("(" + SM_getInfo() + ")");
            if (info.ok && info.segments)
                for (var a = 0; a < info.segments.length; a++) segsToMake.push(info.segments[a]);
        }
        if (!segsToMake.length) return "err:만들 구간이 없음 — 구간을 먼저 담아주세요";

        SM_WRAP_LAST_UNDO = [];
        var made = 0, logs = [];
        for (var q = 0; q < segsToMake.length; q++) {
            var seg = segsToMake[q];
            if (!seg) continue;
            var shortName = "[쇼츠] " + (seg.name || ("Short " + (q + 1)));
            var res = "";
            if (method === "autoreframe") {
                res = SM_makeOne_autoreframe(shortName, seg, srcSeq, opt.preset, opt.arNum, opt.arDen, vSettings, wantW, wantH, opt.capMap, opt.vPosY, opt.titleMogrt, opt.titleMogrt2, opt.noReframe, opt.wrap || null);
            } else if (method === "nest") {
                res = SM_makeOne_nest(shortName, seg, srcItem, vSettings, wantW, wantH, vScale, vPosY);
            } else {
                res = SM_makeOne_tracks(shortName, seg, srcSeq, vSettings, wantW, wantH, vScale, vPosY, cScale, cPosY, capMode, hideOrig, seg.srtPath);
                if (res.indexOf("ok") !== 0) {
                    // 트랙 방식 실패 → 중첩 방식으로 자동 폴백
                    var res2 = SM_makeOne_nest(shortName, seg, srcItem, vSettings, wantW, wantH, vScale, vPosY);
                    if (res2.indexOf("ok") === 0) made++;
                    logs.push(shortName + ": 트랙실패[" + res + "] → 폴백:" + res2);
                    continue;
                }
            }
            if (res.indexOf("ok") === 0) made++;
            logs.push(shortName + ": " + res);
        }
        // 원본 시퀀스 In/Out 정리
        try { srcSeq.clearInPoint(); srcSeq.clearOutPoint(); } catch (e) {}
        // 중간 산출물(~reframe/~tmp) 정리 폴더로 이동
        try { SM_sweepIntermediates(); } catch (eSw) {}
        return "done:" + made + "/" + segsToMake.length + "|" + logs.join(" || ");
    } catch (e) {
        return "err:" + e.toString();
    }
}

// ---------- 현재 시퀀스의 In/Out 지점 읽기 ----------
// 반환: {"ok":true,"in":초,"out":초,"seq":"이름"}  또는  {"ok":false,"reason":...}
function SM_getInOut() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"ok":false,"reason":"no-seq"}';
        var inS = null, outS = null;
        // 최신: Time 객체로
        try { inS = seq.getInPointAsTime().seconds; } catch (e1) {}
        try { outS = seq.getOutPointAsTime().seconds; } catch (e2) {}
        // 폴백: 초(문자열)
        if (inS === null || isNaN(inS)) { try { inS = parseFloat(seq.getInPoint()); } catch (e3) {} }
        if (outS === null || isNaN(outS)) { try { outS = parseFloat(seq.getOutPoint()); } catch (e4) {} }
        if (inS === null || outS === null || isNaN(inS) || isNaN(outS))
            return '{"ok":false,"reason":"no-inout"}';
        if (!(outS > inS + 0.02))
            return '{"ok":false,"reason":"invalid","in":' + inS + ',"out":' + outS + '}';
        return '{"ok":true,"in":' + inS.toFixed(3) + ',"out":' + outS.toFixed(3) +
            ',"seq":"' + SM_esc(seq.name) + '"}';
    } catch (e) {
        return '{"ok":false,"reason":"' + SM_esc(e.toString()) + '"}';
    }
}

// ---------- 진단2: 기존 자막 클립의 컴포넌트/속성 값을 읽어본다 (읽기 전용, 안전) ----------
// 자막의 텍스트·크기·위치 속성에 스크립트가 접근 가능한지 확인이 목적.
function SM_textTest() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "no-seq (자막 있는 시퀀스를 먼저 여세요)";
        var vt = seq.videoTracks;
        var out = ["=== 자막 텍스트 읽기 테스트 ===", "PPro " + app.version, "Vtracks=" + vt.numTracks];

        // V2 이상에서 자막 클립 최대 3개 수집
        var found = [];
        for (var t = 1; t < vt.numTracks && found.length < 3; t++) {
            var clips = vt[t].clips;
            for (var k = 0; k < clips.numItems && found.length < 3; k++) {
                found.push({ track: t + 1, clip: clips[k] });
            }
        }
        if (!found.length) return "V2 이상 트랙에서 자막 클립을 못 찾음";

        for (var f = 0; f < found.length; f++) {
            var clip = found[f].clip;
            out.push("");
            out.push("── 자막클립 #" + (f + 1) + " @V" + found[f].track + " : " + String(clip.name));
            try { out.push("   시간: " + clip.start.seconds.toFixed(2) + "s ~ " + clip.end.seconds.toFixed(2) + "s"); } catch (eTm) {}
            var comps = clip.components;
            for (var i = 0; i < comps.numItems; i++) {
                var c = comps[i];
                var cn = String(c.displayName);
                var props = c.properties;
                var lines = [];
                for (var j = 0; j < props.numItems; j++) {
                    var p = props[j];
                    var pn = String(p.displayName);
                    var isText = (pn.indexOf("텍스트") >= 0 || pn.toLowerCase().indexOf("text") >= 0 || pn.indexOf("소스") >= 0);
                    var val = "?";
                    try {
                        var v = p.getValue();
                        val = String(v);
                        // 텍스트 후보는 자르지 않고 전체를 보여준다 (실제 글자가 읽히는지 확인)
                        if (!isText && val.length > 40) val = val.substring(0, 40) + "…";
                    } catch (eV) { val = "(read불가)"; }
                    lines.push((isText ? "★" : "") + pn + "=" + val);
                }
                out.push("   [" + cn + "] " + lines.join("  ·  "));
            }
        }
        return out.join("\n");
    } catch (e) { return "err:" + e.toString(); }
}

// ---------- 진단: 자막 생성 관련 기능이 이 프리미어에서 되는지 확인 (읽기 전용, 안전) ----------
function SM_probe() {
    var r = [];
    try { r.push("PPro " + app.version); } catch (e) { r.push("version?"); }
    var seq = app.project.activeSequence;
    if (!seq) return "no-seq (시퀀스를 먼저 여세요)";
    // 자막/텍스트 생성 관련 API 존재 여부
    r.push("importMGT=" + (typeof seq.importMGT));
    r.push("createCaptionTrack=" + (typeof seq.createCaptionTrack));
    try { r.push("createSubsequence=" + (typeof seq.createSubsequence)); } catch (e0) {}
    // 트랙 구조와 V2+ 자막 클립
    try {
        var vt = seq.videoTracks;
        r.push("Vtracks=" + vt.numTracks);
        var cap = 0, firstInfo = "";
        for (var i = 1; i < vt.numTracks; i++) cap += vt[i].clips.numItems;
        r.push("V2+clips=" + cap);
        // 첫 자막 클립 샘플: 컴포넌트 이름 나열 (Motion/모션 있으면 위치이동 가능)
        for (var t = 1; t < vt.numTracks && !firstInfo; t++) {
            if (vt[t].clips.numItems > 0) {
                var c = vt[t].clips[0];
                var comps = c.components, names = [];
                for (var k = 0; k < comps.numItems; k++) names.push(String(comps[k].displayName));
                firstInfo = "V" + (t + 1) + " 샘플[" + String(c.name) + " mt=" + c.mediaType + "] comps=" + names.join("/");
            }
        }
        if (firstInfo) r.push(firstInfo);
    } catch (eT) { r.push("track_err:" + eT); }
    return r.join("  |  ");
}

// ==================== 익스포트: 제목 / 하단 넣기 ====================
// ※ 한글이 evalScript 브릿지에서 깨지므로, 패널↔호스트는 encodeURIComponent로 주고받는다.

// importMGT는 비동기라 임포트 직후엔 새 클립이 아직 없다.
// → 임포트 전 트랙별 클립 수(before)를 job으로 쌓아두고, 패널이 잠시 뒤 SM_flushFills()에서
//   '늘어난 트랙의 새 클립'을 찾아 텍스트를 채운다. 못 찾거나 텍스트칸이 아직이면 job을 남겨 재시도.
var SM_pendingFills = [];   // {seqName, texts, before:[...], endSec}
function SM_flushFills() {
    var remain = [], done = 0, out = [];
    for (var i = 0; i < SM_pendingFills.length; i++) {
        var job = SM_pendingFills[i];
        var seq = SM_findSeqByName(job.seqName);
        if (!seq) { out.push("시퀀스없음"); continue; }
        var vt = seq.videoTracks, clip = null, foundT = -1, tb;
        if (typeof job.trackIdx === "number") {
            // 지정 트랙에서만 새 클립을 찾는다 (윗줄=V2, 아랫줄=V3 섞이지 않게)
            tb = job.trackIdx;
            if (tb >= 0 && tb < vt.numTracks) {
                var nowT = 0; try { nowT = vt[tb].clips.numItems; } catch (eN) {}
                if (nowT > (job.before[tb] || 0)) { try { clip = vt[tb].clips[nowT - 1]; foundT = tb; } catch (e2) {} }
            }
        } else {
            for (tb = 0; tb < vt.numTracks; tb++) {
                var now = 0; try { now = vt[tb].clips.numItems; } catch (e) {}
                if (now > (job.before[tb] || 0)) { try { clip = vt[tb].clips[now - 1]; foundT = tb; } catch (e2) {} break; }
            }
        }
        if (!clip) { remain.push(job); out.push("클립대기"); continue; }   // 아직 안 나타남 → 재시도
        try { clip.end = SM_time(job.endSec); } catch (eE) {}   // 시퀀스 길이에 맞춤(텍스트는 사용자가 직접 입력)
        done++; out.push("V" + (foundT + 1) + " 배치완료");
    }
    SM_pendingFills = remain;
    return "flush:" + done + "/" + (done + remain.length) + " [" + out.join(" | ") + "]";
}

// 완료된 쇼츠 시퀀스 목록 (중간 산출물 ~reframe/~tmp 제외). 이름은 URI 인코딩해서 반환.
function SM_listShorts() {
    try {
        var out = [];
        var seqs = app.project.sequences;
        for (var i = 0; i < seqs.numSequences; i++) {
            var nm = String(seqs[i].name);
            if (nm.indexOf("[") !== 0) continue;             // [쇼츠] 로 시작
            if (nm.indexOf("~reframe") >= 0 || nm.indexOf("~tmp") >= 0) continue;
            out.push('"' + encodeURIComponent(nm) + '"');
        }
        return '{"ok":true,"items":[' + out.join(",") + ']}';
    } catch (e) { return '{"ok":false,"reason":"' + SM_esc(e.toString()) + '"}'; }
}

// 파일 선택 대화상자 → 경로(URI 인코딩) 반환. kindHint는 안내 문구용.
function SM_pickFile(kindHint) {
    try {
        var f = File.openDialog(decodeURIComponent(kindHint || "%ED%8C%8C%EC%9D%BC%20%EC%84%A0%ED%83%9D"));
        if (!f) return "";
        return encodeURIComponent(String(f.fsName));
    } catch (e) { return "err:" + e; }
}

// 폴더 선택 대화상자 → 경로(URI 인코딩)
function SM_pickFolder() {
    try {
        var f = Folder.selectDialog(decodeURIComponent("%EC%A0%80%EC%9E%A5%20%ED%8F%B4%EB%8D%94%20%EC%84%A0%ED%83%9D"));
        if (!f) return "";
        return encodeURIComponent(String(f.fsName));
    } catch (e) { return "err:" + e; }
}

// 프리셋/폴더 유효성 검사 → {folder} 또는 {err}
function SM_exportCheck(o) {
    if (!o.preset) return { err: "출력 프리셋(.epr)이 없습니다." };
    var preF = new File(o.preset);
    if (!preF.exists) return { err: "프리셋 파일이 없습니다: " + o.preset };
    var folderPath = o.folder;
    if (!folderPath) { try { folderPath = Folder.desktop.fsName; } catch (eD) {} }   // 미지정 시 바탕화면
    if (!folderPath) return { err: "저장 폴더를 선택하세요." };
    var folder = new Folder(folderPath);
    if (!folder.exists) return { err: "저장 폴더가 없습니다: " + folderPath };
    return { folder: folderPath };
}

// 한 시퀀스를 프리셋으로 파일 출력. 반환: "ok:경로" 또는 "err:..."
function SM_exportOneSeq(seq, preset, folderPath) {
    var safeName = String(seq.name).replace(/[\/\\:*?"<>|]/g, "_");
    var outPath = folderPath + "/" + safeName + ".mp4";
    var waType = 0;   // 0 = 전체 시퀀스
    try { if (app.encoder && typeof app.encoder.ENCODE_ENTIRE !== "undefined") waType = app.encoder.ENCODE_ENTIRE; } catch (eW) {}
    try { seq.exportAsMediaDirect(outPath, preset, waType); return "ok:" + outPath; }
    catch (eX) { return "err:" + eX; }
}

// 현재 작업 중인(활성) 시퀀스만 파일 출력. opt: {folder, preset}
function SM_exportSequence(encJson) {
    try {
        var o = eval("(" + decodeURIComponent(encJson) + ")");
        var seq = app.project.activeSequence;
        if (!seq) return "err:작업 중인 시퀀스가 없습니다. 출력할 시퀀스를 먼저 여세요.";
        var chk = SM_exportCheck(o);
        if (chk.err) return "err:" + chk.err;
        return SM_exportOneSeq(seq, o.preset, chk.folder);
    } catch (e) { return "err:" + e.toString(); }
}

// [쇼츠]로 만든 모든 시퀀스(~reframe/~tmp 제외)를 한 번에 파일 출력
function SM_exportSequenceAll(encJson) {
    try {
        var o = eval("(" + decodeURIComponent(encJson) + ")");
        var chk = SM_exportCheck(o);
        if (chk.err) return "err:" + chk.err;
        var seqs = app.project.sequences;
        var targets = [];
        for (var i = 0; i < seqs.numSequences; i++) {
            var nm = String(seqs[i].name);
            if (nm.indexOf("[") !== 0) continue;                 // [쇼츠] 로 시작
            if (nm.indexOf("~reframe") >= 0 || nm.indexOf("~tmp") >= 0) continue;
            targets.push(seqs[i]);
        }
        if (!targets.length) return "err:[쇼츠] 시퀀스를 찾지 못했습니다.";
        var okN = 0, msgs = [];
        for (var t = 0; t < targets.length; t++) {
            var r = SM_exportOneSeq(targets[t], o.preset, chk.folder);
            if (r.indexOf("ok") === 0) okN++;
            msgs.push(String(targets[t].name) + ":" + r);
        }
        return "okall:" + okN + "/" + targets.length + "|" + msgs.join(" || ");
    } catch (e) { return "err:" + e.toString(); }
}

function SM_findSeqByName(name) {
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++)
        if (String(seqs[i].name) === String(name)) return seqs[i];
    return null;
}

// 시퀀스에 비디오 트랙이 need개 이상 되도록 QE로 추가 (V2·V3 확보용)
function SM_ensureVideoTracks(seq, need) {
    try {
        if (seq.videoTracks.numTracks >= need) return;
        app.enableQE();
        var qs = qe.project.getActiveSequence();
        var guard = 0;
        while (seq.videoTracks.numTracks < need && guard < 12) {
            try { qs.addTracks(1, seq.videoTracks.numTracks, 0, 0, 0, 0); }
            catch (e) { try { qs.addTracks(1, seq.videoTracks.numTracks); } catch (e2) { break; } }
            guard++;
        }
    } catch (eQ) {}
}

// 시퀀스 총 길이(초)
function SM_seqEndSeconds(seq) {
    var end = 0;
    try {
        var vt = seq.videoTracks;
        for (var t = 0; t < vt.numTracks; t++) {
            var clips = vt[t].clips;
            for (var c = 0; c < clips.numItems; c++) {
                var e = clips[c].end.seconds;
                if (e > end) end = e;
            }
        }
    } catch (e) {}
    if (end <= 0) end = 10;
    return end;
}

// V1 영상 클립의 화면상 세로 범위(px) 추정 → {top, bottom}
function SM_videoBand(seq, W, H) {
    var band = { top: 0, bottom: H };
    try {
        var clip = seq.videoTracks[0].clips[0];
        var comps = clip.components, motion = null;
        for (var i = 0; i < comps.numItems; i++) {
            var dn = String(comps[i].displayName);
            if (dn === "Motion" || dn === "모션") { motion = comps[i]; break; }
        }
        var scale = 100, posY = 0.5;
        if (motion) {
            var props = motion.properties;
            for (var j = 0; j < props.numItems; j++) {
                var pn = String(props[j].displayName);
                if (pn === "Scale" || pn === "크기" || pn === "비율") { try { scale = props[j].getValue(); } catch (e1) {} }
                if (pn === "Position" || pn === "위치") { try { var pv = props[j].getValue(); if (pv && pv.length >= 2) posY = pv[1]; } catch (e2) {} }
            }
        }
        // 리프레임 영상은 폭을 프레임에 맞춤(scale 100 → 폭 W). 세로는 1:1 가정 후 scale 반영(근사).
        var vidH = W * (scale / 100);
        var cy = posY * H;
        band.top = cy - vidH / 2;
        band.bottom = cy + vidH / 2;
        if (band.top < 0) band.top = 0;
        if (band.bottom > H) band.bottom = H;
    } catch (e) {}
    return band;
}

// 프로그램 모니터 강제 재렌더 (setValue 후 화면 갱신 안 되는 문제 해결 — 재생헤드 살짝 이동)
function SM_forceRedraw() {
    try {
        var s = app.project.activeSequence;
        if (!s) return;
        var pos = s.getPlayerPosition();
        var t = parseFloat(pos.ticks);
        s.setPlayerPosition(String(t + 254016000000));   // +1초
        s.setPlayerPosition(String(t));                    // 원위치
    } catch (e) {}
}

// mogrt의 "Source Text" 컨트롤들을 순서대로 texts[0], texts[1], ...로 채움
// texts: 문자열 배열(윗줄/아랫줄). 반환: 진단 문자열
function SM_setMogrtText(clip, texts) {
    if (typeof texts === "string") texts = [texts];
    var comps = [], setOK = 0, ti = 0;
    try { var mgt = clip.getMGTComponent(); if (mgt) comps.push(mgt); } catch (eG) {}
    try { var cs = clip.components; for (var i = 0; i < cs.numItems; i++) comps.push(cs[i]); } catch (eC) {}
    for (var c = 0; c < comps.length; c++) {
        var props = null, pn = 0;
        try { props = comps[c].properties; pn = props.numItems; } catch (eP) { continue; }
        for (var j = 0; j < pn; j++) {
            var p = props[j], dn = "";
            try { dn = String(p.displayName); } catch (eDN) {}
            if (dn === "Source Text" || dn === "소스 텍스트") {
                var val = (ti < texts.length) ? texts[ti] : "";
                ti++;
                var okc = "x";
                try { p.setValue(val, true); okc = "1"; } catch (e1) { try { p.setValue(val); okc = "2"; } catch (e2) {} }
                var af = ""; try { af = String(p.getValue()); } catch (e3b) {}
                if (val === "" || af.indexOf(val) >= 0) setOK++;
            }
        }
    }
    SM_forceRedraw();   // 화면 강제 갱신
    return (ti > 0 ? (setOK >= ti ? "채움OK" + ti : "채움" + setOK + "/" + ti) : "텍스트칸없음");
}

// mogrt(제목 템플릿)를 현재 시퀀스에 올리기만 함(비동기). 길이 맞춤은 SM_flushFills()가 담당.
// 글자는 사용자가 화면에서 직접 입력(프리미어 제작 템플릿은 스크립트 자동 입력 불가). 위치·크기는 원본 그대로.
function SM_placeMogrt(seq, mogrtPath, trackIdx, endSec) {
    var f = new File(mogrtPath);
    if (!f.exists) return "mogrt없음";
    var vt = seq.videoTracks, before = [], tb;
    for (tb = 0; tb < vt.numTracks; tb++) { try { before[tb] = vt[tb].clips.numItems; } catch (e0) { before[tb] = 0; } }
    try { seq.importMGT(mogrtPath, SM_time(0).ticks, trackIdx, -1); }
    catch (e1) { return "importMGT실패:" + e1; }
    SM_pendingFills.push({ seqName: String(seq.name), before: before, endSec: endSec, trackIdx: trackIdx });
    return "제목 템플릿 올림";
}

// 프로젝트에서 같은 '미디어 파일 경로'를 쓰는 아이템을 찾음 (이름이 달라도 같은 파일이면 매칭)
function SM_findItemByPath(bin, path) {
    for (var i = 0; i < bin.children.numItems; i++) {
        var it = bin.children[i];
        if (it.type === ProjectItemType.BIN) {
            var found = SM_findItemByPath(it, path);
            if (found) return found;
        } else {
            var mp = "";
            try { mp = String(it.getMediaPath()); } catch (e) {}
            if (mp && mp === String(path)) return it;
        }
    }
    return null;
}

// 이미지를 넣고 하단 여백 크기에 맞춰 축소·배치. imgW/imgH = 원본 픽셀(0이면 근사)
function SM_placeImage(seq, imgPath, imgW, imgH, band, W, H, trackIdx, endSec) {
    var f = new File(imgPath);
    if (!f.exists) return "이미지파일없음(경로확인:" + imgPath + ")";
    // 같은 파일이 이미 프로젝트에 있으면 '그 하나'를 재사용 — 경로 매칭 우선, 이름은 폴백
    var item = SM_findItemByPath(app.project.rootItem, f.fsName);
    if (!item) item = SM_findItemByName(app.project.rootItem, f.name);
    if (!item) {
        var ok = false;
        try { ok = app.project.importFiles([f.fsName], true, app.project.rootItem, false); } catch (eImp) { return "임포트오류:" + eImp; }
        if (!ok) return "임포트실패";
        item = SM_findItemByPath(app.project.rootItem, f.fsName);
        if (!item) item = SM_findItemByName(app.project.rootItem, f.name);
    }
    if (!item) return "임포트아이템못찾음";
    var track = null;
    try { track = seq.videoTracks[trackIdx]; } catch (eTk) {}
    if (!track) { try { track = seq.videoTracks[seq.videoTracks.numTracks - 1]; } catch (eTk2) {} }
    if (!track) return "트랙없음";
    try { track.insertClip(item, SM_time(0)); }
    catch (e1) { try { track.overwriteClip(item, SM_time(0)); } catch (e2) { return "삽입실패:" + e2; } }
    var clip = track.clips[track.clips.numItems - 1];
    try { clip.end = SM_time(endSec); } catch (eE) {}
    var bh = H - band.bottom;                        // 하단 여백 높이(px)
    var bottomCenterY = (band.bottom + H) / 2 / H;   // 하단 여백 중앙(정규화)
    // 하단 영역(폭 W*0.92 × 높이 bh*0.9) 안에 원본 비율 유지하며 들어가게 스케일 계산
    var boxW = W * 0.92, boxH = bh * 0.9;
    var SHRINK = 0.6;   // 하단 여백에 딱 맞춘 크기보다 40% 더 작게
    var scalePct;
    if (imgW > 0 && imgH > 0 && bh > 0) {
        var s = Math.min(boxW / imgW, boxH / imgH);   // 100%=원본픽셀 가정
        scalePct = s * 100 * SHRINK;
        if (scalePct > 100) scalePct = 100;           // 원본보다 키우진 않음
    } else {
        scalePct = ((bh > 0) ? (bh / H * 100) : 30) * SHRINK;   // 크기 모를 때 근사
    }
    try { SM_reframeClip(clip, scalePct, bottomCenterY); } catch (eP) {}
    return "ok(" + (imgW ? imgW + "x" + imgH + "→" : "") + "스케일" + Math.round(scalePct) + "%)";
}

// 익스포트 적용 (encJson: encodeURIComponent된 옵션 JSON)
//  opt: {seqName, title, titleMogrt, bottomType:"image"|"text"|"none", bottomText, bottomImage, bottomMogrt}
// 한 시퀀스(seq)에 하단 이미지를 V4에 배치. seq는 반드시 현재 활성 시퀀스여야 함
// (SM_ensureVideoTracks가 QE 활성 시퀀스에 트랙을 추가하기 때문)
function SM_applyImageToSeq(seq, o) {
    if (!seq) return "err:시퀀스없음";
    var st = seq.getSettings();
    var W = parseInt(st.videoFrameWidth, 10) || 1080;
    var H = parseInt(st.videoFrameHeight, 10) || 1920;
    var band = SM_videoBand(seq, W, H);
    var endSec = SM_seqEndSeconds(seq);
    SM_ensureVideoTracks(seq, 4);   // V4 확보 (제목=V2·V3는 만들 때 올림, 하단 이미지=V4)
    if (o.bottomImage) {
        var r = SM_placeImage(seq, o.bottomImage, o.bottomImageW || 0, o.bottomImageH || 0, band, W, H, 3, endSec);
        if (r.indexOf("ok") !== 0) return "err:하단 이미지 실패 - " + r;   // 실패를 성공으로 감추지 않음
        return "ok:" + r;
    }
    return "ok:(넣을 이미지 없음)";
}

// 현재 작업 중인(활성) 시퀀스에만 하단 이미지 적용
function SM_applyExport(encJson) {
    try {
        var o = eval("(" + decodeURIComponent(encJson) + ")");
        var seq = app.project.activeSequence;
        if (!seq) return "err:작업 중인 시퀀스가 없습니다. 쇼츠 시퀀스를 먼저 여세요.";
        return SM_applyImageToSeq(seq, o);
    } catch (e) { return "err:" + e.toString(); }
}

// [쇼츠]로 만든 모든 시퀀스(~reframe/~tmp 제외)에 하단 이미지를 한 번에 적용
function SM_applyExportAll(encJson) {
    try {
        var o = eval("(" + decodeURIComponent(encJson) + ")");
        if (!o.bottomImage) return "err:첨부된 하단 이미지가 없습니다.";
        var orig = null;
        try { orig = app.project.activeSequence; } catch (eA) {}
        var seqs = app.project.sequences;
        var targets = [];
        for (var i = 0; i < seqs.numSequences; i++) {
            var nm = String(seqs[i].name);
            if (nm.indexOf("[") !== 0) continue;                 // [쇼츠] 로 시작
            if (nm.indexOf("~reframe") >= 0 || nm.indexOf("~tmp") >= 0) continue;
            targets.push(seqs[i]);
        }
        if (!targets.length) return "err:[쇼츠] 시퀀스를 찾지 못했습니다.";
        var okN = 0, msgs = [];
        for (var t = 0; t < targets.length; t++) {
            var sq = targets[t];
            try { app.project.openSequence(sq.sequenceID); } catch (eO) {}   // 활성화(트랙 추가 위해 필요)
            var aseq = null;
            try { aseq = app.project.activeSequence; } catch (eAS) {}
            if (!aseq) aseq = sq;
            var r = SM_applyImageToSeq(aseq, o);
            if (r.indexOf("ok") === 0) okN++;
            msgs.push(String(aseq.name) + ":" + r);
        }
        // 원래 보고 있던 시퀀스로 복귀
        try { if (orig) app.project.openSequence(orig.sequenceID); } catch (eR) {}
        return "okall:" + okN + "/" + targets.length + "|" + msgs.join(" || ");
    } catch (e) { return "err:" + e.toString(); }
}


// =====================================================================
// [1.0.4] 자막 자동 줄바꿈
//   쇼츠(~reframe) 시퀀스에서 화면 폭을 넘는 자막을 찾아, 가운데에 가까운
//   띄어쓰기를 줄바꿈으로 바꿔 두 줄(필요하면 세 줄 이상)로 만든다.
//   - 텍스트 값(JSON)을 통째로 다시 쓰지 않고, 글자 부분만 "수술"하듯 바꾼다
//     → 글꼴·색·스타일 정보는 그대로 유지된다.
//   - 바꾸기 전 원래 값을 되돌리기용으로 돌려준다 (SM_restoreCaptions).
// =====================================================================

var SM_WRAP_LAST_UNDO = [];   // 쇼츠 만들기 중 자동 줄바꿈한 항목(되돌리기용)

// 옵션 문자열(eval) → 객체
function SM_wrapOpt(o) {
    o = o || {};
    return {
        safe: (typeof o.safe === "number" && o.safe > 20 && o.safe <= 100) ? o.safe : 90, // 화면 폭의 몇 %까지 쓸지
        maxChars: (typeof o.maxChars === "number" && o.maxChars > 0) ? o.maxChars : 0,    // 한 줄 최대 글자 수(0=자동)
        tracks: o.tracks || null   // {"2":true,...} 대상 트랙(없으면 V2 이상 전체)
    };
}

// 글자 하나의 대략적인 폭 (글자 크기 1 기준)
function SM_charW(ch) {
    var c = ch.charCodeAt(0);
    if (c === 32) return 0.28;
    if ((c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F) ||
        (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3040 && c <= 0x30FF) || (c >= 0xFF00 && c <= 0xFFEF)) return 0.9;
    if (c >= 48 && c <= 57) return 0.56;                  // 숫자
    if (c >= 65 && c <= 90) return 0.66;                  // 대문자
    if (c >= 97 && c <= 122) return 0.52;                 // 소문자
    if (".,:;'!|`".indexOf(ch) >= 0) return 0.28;
    if ("\"()[]{}-~·…?".indexOf(ch) >= 0) return 0.40;
    if (c > 0x2000) return 0.95;                          // 기타 기호·이모지
    return 0.55;
}
function SM_lineUnits(s) { var w = 0; for (var i = 0; i < s.length; i++) w += SM_charW(s.charAt(i)); return w; }
function SM_visLen(s) { return String(s).replace(/\s/g, "").length; }

// JSON 문자열 리터럴을 디코드하면서, 디코드된 글자 i가 원본의 어디(raw 범위)인지 기록
// raw[q] 는 여는 따옴표 다음 위치. 반환: {text, map:[[start,end],...], end: 닫는 따옴표 위치}
function SM_decodeJsonStr(raw, q) {
    var text = "", map = [], i = q;
    while (i < raw.length) {
        var ch = raw.charAt(i);
        if (ch === '"') return { text: text, map: map, end: i };
        if (ch === "\\") {
            var n = raw.charAt(i + 1), dec = null, len = 2;
            if (n === "n") dec = "\n"; else if (n === "r") dec = "\r"; else if (n === "t") dec = "\t";
            else if (n === "b") dec = "\b"; else if (n === "f") dec = "\f";
            else if (n === "u") { dec = String.fromCharCode(parseInt(raw.substr(i + 2, 4), 16)); len = 6; }
            else dec = n;
            text += dec; map.push([i, i + len]); i += len;
        } else {
            text += ch; map.push([i, i + 1]); i++;
        }
    }
    return null;
}

// 텍스트 속성 값(raw)에서 글자 부분을 찾는다.
//   형식 A(프리미어 기본 텍스트): ..."mText":"..."...
//   형식 B(모션 그래픽 템플릿): ..."textEditValue":"..."...
function SM_findTextField(raw) {
    var keys = ['"mText":"', '"textEditValue":"'];
    for (var k = 0; k < keys.length; k++) {
        var p = raw.indexOf(keys[k]);
        if (p < 0) continue;
        var d = SM_decodeJsonStr(raw, p + keys[k].length);
        if (d) { d.key = keys[k]; d.fmt = (k === 0) ? "A" : "B"; return d; }
    }
    return null;
}
function SM_fontSize(raw) {
    var m = raw.match(/"mFontSize"\s*:\s*\[?\s*([0-9.]+)/) || raw.match(/"fontSizeEditValue"\s*:\s*\[?\s*([0-9.]+)/);
    var v = m ? parseFloat(m[1]) : 0;
    return (v > 1 && v < 2000) ? v : 100;
}

// 컴포넌트에서 이름으로 "크기(Scale)" 값(%)을 찾음
function SM_scaleOf(comp) {
    try {
        var props = comp.properties;
        for (var j = 0; j < props.numItems; j++) {
            var pn = String(props[j].displayName);
            if (pn === "Scale" || pn === "크기" || pn === "비율 조정" || pn === "비율") {
                var v = parseFloat(props[j].getValue());
                if (v > 0 && v < 10000) return v;
            }
        }
    } catch (e) {}
    return 100;
}
function SM_isSourceTextName(pn) {
    pn = String(pn);
    return pn === "Source Text" || pn === "소스 텍스트" || pn === "원본 텍스트" || pn === "텍스트 소스";
}

// 한 줄을 화면 폭(limit 단위)에 맞게 나눈다. 결과를 out에 넣음: {at: 전체 위치, type:"space"|"insert"}
//   필요한 최소 줄 수를 구한 뒤, 그 줄 수 안에서 줄 길이가 가장 고르게 되도록 띄어쓰기를 고른다.
function SM_measure(s, maxChars) { return (maxChars > 0) ? SM_visLen(s) : SM_lineUnits(s); }
function SM_splitLine(line, limit, maxChars, base, out) {
    var cap = (maxChars > 0) ? maxChars : limit;
    if (SM_measure(line, maxChars) <= cap || line.length < 2) return;
    // 띄어쓰기 위치들 (앞뒤에 글자가 있는 것만)
    var sp = [];
    for (var i = 1; i < line.length - 1; i++) if (line.charAt(i) === " ") sp.push(i);
    var bounds = [-1].concat(sp).concat([line.length]);   // 조각 경계
    var m = bounds.length - 1;                            // 조각(단어) 수
    function seg(a, b) { return SM_measure(line.substring(bounds[a] + 1, bounds[b]), maxChars); }
    var chosen = null;
    if (m >= 2) {
        // n줄로 나눌 때 가장 긴 줄을 최소로: best[k][j] = 앞 j조각을 k줄로 나눈 최솟값
        for (var n = 2; n <= m && !chosen; n++) {
            var best = [], from = [];
            for (var k = 0; k <= n; k++) { best.push([]); from.push([]); for (var j = 0; j <= m; j++) { best[k].push(1e9); from[k].push(-1); } }
            best[0][0] = 0;
            for (k = 1; k <= n; k++) for (j = k; j <= m; j++) for (var x = k - 1; x < j; x++) {
                if (best[k - 1][x] >= 1e9) continue;
                var v = Math.max(best[k - 1][x], seg(x, j));
                if (v < best[k][j]) { best[k][j] = v; from[k][j] = x; }
            }
            if (best[n][m] <= cap || n === m) {
                chosen = []; var jj = m;
                for (k = n; k > 1; k--) { jj = from[k][jj]; chosen.unshift(bounds[jj]); }
            }
        }
    }
    var pieces = [];   // [시작, 끝) 조각들
    if (chosen && chosen.length) {
        var st = 0;
        for (var c = 0; c < chosen.length; c++) {
            out.push({ at: base + chosen[c], type: "space" });
            pieces.push([st, chosen[c]]); st = chosen[c] + 1;
        }
        pieces.push([st, line.length]);
    } else pieces.push([0, line.length]);
    // 띄어쓰기로 나눠도 넘치는 조각은 글자 단위로 자름
    for (var q = 0; q < pieces.length; q++) {
        var s0 = pieces[q][0], txt = line.substring(s0, pieces[q][1]);
        if (SM_measure(txt, maxChars) <= cap || txt.length < 2) continue;
        var parts = Math.ceil(SM_measure(txt, maxChars) / cap), per = Math.ceil(txt.length / parts);
        for (var z = 1; z < parts; z++) {
            var cut = z * per;
            while (cut < txt.length - 1 && ".,!?…~)]\"'".indexOf(txt.charAt(cut)) >= 0) cut++;
            if (cut > 0 && cut < txt.length) out.push({ at: base + s0 + cut, type: "insert" });
        }
    }
}

// 텍스트 전체에 대해 줄바꿈 위치 계산. 반환: [{at:전체 위치, type}]
function SM_planBreaks(text, limit, maxChars) {
    var out = [], start = 0;
    for (var i = 0; i <= text.length; i++) {
        var ch = (i < text.length) ? text.charAt(i) : "\r";
        if (ch === "\r" || ch === "\n" || i === text.length) {
            SM_splitLine(text.substring(start, i), limit, maxChars, start, out);
            start = i + 1;
        }
    }
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
}

// raw 값에 줄바꿈을 적용한 새 raw를 만든다. 실패 시 null
function SM_applyBreaks(raw, fld, breaks) {
    // 기존 줄바꿈이 원본에서 어떻게 적혀 있었는지 따라 씀 (없으면 \r 이스케이프)
    var brRaw = "\\r";
    for (var e = 0; e < fld.text.length; e++) {
        var ce = fld.text.charAt(e);
        if (ce === "\r" || ce === "\n") { brRaw = raw.substring(fld.map[e][0], fld.map[e][1]); break; }
    }
    var inserts = 0, res = raw;
    // 뒤에서부터 바꿔야 앞쪽 위치가 안 밀린다
    for (var k = breaks.length - 1; k >= 0; k--) {
        var b = breaks[k], rng;
        if (b.type === "space") {
            rng = fld.map[b.at];
            res = res.substring(0, rng[0]) + brRaw + res.substring(rng[1]);
        } else {
            if (fld.fmt !== "B") return null;   // 형식 A는 글자 수가 바뀌면 스타일이 깨질 수 있어 안 함
            rng = fld.map[b.at];
            res = res.substring(0, rng[0]) + brRaw + res.substring(rng[0]);
            inserts++;
        }
    }
    if (inserts > 0) {
        // 형식 B: 글자 수가 늘어난 만큼 마지막 스타일 구간 길이를 늘림
        var m = res.match(/"fontTextRunLength"\s*:\s*\[([0-9,\s]*)\]/);
        if (m) {
            var arr = m[1].split(","), last = arr.length - 1;
            arr[last] = String(parseInt(arr[last], 10) + inserts);
            res = res.replace(m[0], '"fontTextRunLength":[' + arr.join(",") + "]");
        }
    }
    return res;
}

// 클립 하나 처리. frameW = 시퀀스 가로 픽셀. undo 배열에 원래 값 저장.
// 반환: {changed, skipped, reason, detail[]}
function SM_wrapClip(clip, frameW, opt, undo, seqId, tIdx) {
    var r = { changed: 0, skipped: 0, reason: "", detail: [] };
    var comps;
    try { comps = clip.components; } catch (e0) { r.reason = "컴포넌트 없음"; return r; }
    var motionScale = 100;
    for (var mi = 0; mi < comps.numItems; mi++) {
        var mn = String(comps[mi].displayName);
        if (mn === "Motion" || mn === "모션") motionScale = SM_scaleOf(comps[mi]);
    }
    var foundText = false;
    for (var i = 0; i < comps.numItems; i++) {
        var comp = comps[i], props;
        try { props = comp.properties; } catch (e1) { continue; }
        var textScale = SM_scaleOf(comp);
        for (var j = 0; j < props.numItems; j++) {
            var p = props[j];
            // 이름(언어마다 다름)에 기대지 않고, 값 안에 글자 정보가 있으면 자막 텍스트로 본다
            var raw;
            try { raw = p.getValue(); } catch (e2) { continue; }
            if (typeof raw !== "string") { try { raw = String(raw); } catch (e2b) { continue; } }
            var fld = (raw.length > 8) ? SM_findTextField(raw) : null;
            if (!fld) {
                if (SM_isSourceTextName(p.displayName)) { r.skipped++; r.reason = "텍스트 형식 인식 불가: " + raw.substring(0, 60); }
                continue;
            }
            foundText = true;
            var fs = SM_fontSize(raw);
            var unitPx = fs * (textScale / 100) * (motionScale / 100);
            var limit = (frameW * opt.safe / 100) / unitPx;     // 한 줄에 허용되는 폭(글자 크기 1 단위)
            var breaks = SM_planBreaks(fld.text, limit, opt.maxChars);
            var info = "「" + fld.text.replace(/[\r\n]/g, "⏎") + "」 글자" + Math.round(fs) + " ×" + Math.round(textScale) + "%" +
                (motionScale !== 100 ? " ×모션" + Math.round(motionScale) + "%" : "") +
                " · 예상폭 " + Math.round(SM_lineUnits(fld.text.split(/[\r\n]/)[0]) * unitPx) + "/" + Math.round(frameW * opt.safe / 100) + "px";
            if (!breaks.length) { r.detail.push(info + " → 그대로(넘치지 않음)"); continue; }
            var nraw = SM_applyBreaks(raw, fld, breaks);
            if (!nraw) { r.skipped++; r.detail.push(info + " → 건너뜀(띄어쓰기 없음)"); continue; }
            try { p.setValue(nraw, true); } catch (e3) { r.skipped++; r.detail.push(info + " → 쓰기 실패 " + e3); continue; }
            // 다시 읽어서 확인
            var ok = false, after = "";
            try {
                var chk = SM_findTextField(String(p.getValue()));
                if (chk) { after = chk.text; ok = (chk.text !== fld.text) && (SM_visLen(chk.text) === SM_visLen(fld.text)); }
            } catch (e4) {}
            if (ok) {
                r.changed++;
                undo.push({ seq: seqId, t: tIdx, s: String(clip.start.ticks), c: i, p: j, raw: encodeURIComponent(raw) });
                r.detail.push(info + " → 「" + after.replace(/[\r\n]/g, "⏎") + "」");
            } else {
                try { p.setValue(raw, true); } catch (e5) {}   // 확인 실패 → 원래대로
                r.skipped++; r.detail.push(info + " → 반영 확인 실패(원래대로 둠)");
            }
        }
    }
    if (!foundText && !r.reason) { r.reason = "텍스트 클립 아님"; r.diag = SM_clipDiag(clip); }
    return r;
}

// 진단: 클립의 컴포넌트·속성 이름과 값 앞부분 (텍스트를 못 찾았을 때 원인 파악용)
function SM_clipDiag(clip) {
    var out = [];
    try {
        out.push("클립: " + String(clip.name));
        var comps = clip.components;
        for (var i = 0; i < comps.numItems; i++) {
            var ps = [], props = comps[i].properties;
            for (var j = 0; j < props.numItems && j < 25; j++) {
                var v = "?";
                try { v = String(props[j].getValue()); } catch (e) { v = "(읽기불가)"; }
                v = v.replace(/[\r\n]/g, "⏎");
                if (v.length > 70) v = v.substring(0, 70) + "…";
                ps.push(String(props[j].displayName) + "=" + v);
            }
            out.push(" [" + String(comps[i].displayName) + "] " + ps.join(" · "));
        }
    } catch (e2) { out.push("진단 오류: " + e2); }
    return out.join("\n");
}

function SM_seqWidth(seq) {
    try { var s = seq.getSettings(); var w = parseInt(s.videoFrameWidth, 10); if (w > 0) return w; } catch (e) {}
    try { var w2 = parseInt(seq.frameSizeHorizontal, 10); if (w2 > 0) return w2; } catch (e2) {}
    return 1080;
}

// 시퀀스 전체(V2 이상) 자막 줄바꿈 (내부용)
function SM_wrapCaptionsOfSeq(seq, opt, undo) {
    var tot = { clips: 0, changed: 0, skipped: 0, detail: [] };
    var W = SM_seqWidth(seq), seqId = "";
    try { seqId = String(seq.sequenceID); } catch (e) {}
    var vt = seq.videoTracks;
    for (var t = 1; t < vt.numTracks; t++) {
        if (opt.tracks && !opt.tracks["" + (t + 1)]) continue;
        var clips = vt[t].clips;
        for (var c = 0; c < clips.numItems; c++) {
            var r = SM_wrapClip(clips[c], W, opt, undo, seqId, t);
            if (r.reason === "텍스트 클립 아님") { if (!tot.diag && r.diag) tot.diag = "V" + (t + 1) + " " + r.diag; continue; }
            tot.clips++; tot.changed += r.changed; tot.skipped += r.skipped;
            for (var d = 0; d < r.detail.length; d++) tot.detail.push("V" + (t + 1) + " " + r.detail[d]);
        }
    }
    tot.width = W;
    if (!tot.clips && tot.diag) tot.detail.push("자막 텍스트를 못 찾음 — 진단:\n" + tot.diag);
    return tot;
}

// 되돌리기 목록 → 문자열 ("a,b,c" 형태의 JSON 배열)
function SM_undoToStr(undo) {
    var a = [];
    for (var i = 0; i < undo.length; i++) {
        var u = undo[i];
        a.push('{"seq":"' + SM_esc(u.seq) + '","t":' + u.t + ',"s":"' + u.s + '","c":' + u.c + ',"p":' + u.p + ',"raw":"' + u.raw + '"}');
    }
    return "[" + a.join(",") + "]";
}

// [버튼] 지금 열린 시퀀스의 자막 줄바꿈. optStr 예: {"safe":88,"maxChars":0}
// 반환: {"ok":true,"changed":3,"skipped":0,"clips":12,"width":950,"log":"...","undo":[...]}
function SM_wrapCaptions(optStr) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"ok":false,"reason":"열린 시퀀스가 없습니다"}';
        var opt = SM_wrapOpt(optStr ? eval("(" + optStr + ")") : null);
        var undo = [];
        var r = SM_wrapCaptionsOfSeq(seq, opt, undo);
        return '{"ok":true,"seq":"' + SM_esc(seq.name) + '","changed":' + r.changed + ',"skipped":' + r.skipped +
            ',"clips":' + r.clips + ',"width":' + r.width + ',"log":"' + encodeURIComponent(r.detail.join("\n")) +
            '","undo":' + SM_undoToStr(undo) + '}';
    } catch (e) { return '{"ok":false,"reason":"' + SM_esc(e.toString()) + '"}'; }
}

// [버튼] 타임라인에서 선택한 자막 클립만 줄바꿈 (테스트용)
function SM_wrapSelected(optStr) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"ok":false,"reason":"열린 시퀀스가 없습니다"}';
        var opt = SM_wrapOpt(optStr ? eval("(" + optStr + ")") : null);
        var sel = null;
        try { sel = seq.getSelection(); } catch (eS) {}
        if (!sel || !sel.length) return '{"ok":false,"reason":"타임라인에서 자막 클립을 하나 선택하세요"}';
        var W = SM_seqWidth(seq), seqId = "";
        try { seqId = String(seq.sequenceID); } catch (e0) {}
        var undo = [], changed = 0, skipped = 0, logs = [], clipsN = 0;
        for (var i = 0; i < sel.length; i++) {
            var clip = sel[i], tIdx = -1;
            try { if (clip.mediaType && String(clip.mediaType) !== "Video") continue; } catch (eM) {}
            // 트랙 번호 찾기
            for (var t = 0; t < seq.videoTracks.numTracks && tIdx < 0; t++) {
                var cl = seq.videoTracks[t].clips;
                for (var k = 0; k < cl.numItems; k++) {
                    if (String(cl[k].start.ticks) === String(clip.start.ticks) && String(cl[k].name) === String(clip.name)) { tIdx = t; break; }
                }
            }
            var r = SM_wrapClip(clip, W, opt, undo, seqId, tIdx);
            if (r.reason === "텍스트 클립 아님") { logs.push("자막 텍스트를 못 찾음 — 진단:\n" + (r.diag || String(clip.name))); continue; }
            clipsN++; changed += r.changed; skipped += r.skipped;
            for (var d = 0; d < r.detail.length; d++) logs.push(r.detail[d]);
            if (r.reason) logs.push(r.reason);
        }
        try { logs.push("(PPro " + app.version + ", 시퀀스 폭 " + W + "px)"); } catch (eV) {}
        return '{"ok":true,"seq":"' + SM_esc(seq.name) + '","changed":' + changed + ',"skipped":' + skipped +
            ',"clips":' + clipsN + ',"width":' + W + ',"log":"' + encodeURIComponent(logs.join("\n")) +
            '","undo":' + SM_undoToStr(undo) + '}';
    } catch (e) { return '{"ok":false,"reason":"' + SM_esc(e.toString()) + '"}'; }
}

// 쇼츠 만들기 중 자동 줄바꿈한 것들의 되돌리기 목록을 가져감(한 번 가져가면 비움)
function SM_takeLastWrapUndo() {
    var s = SM_undoToStr(SM_WRAP_LAST_UNDO);
    SM_WRAP_LAST_UNDO = [];
    return s;
}

// 되돌리기: undo 목록(encodeURIComponent된 JSON 배열)의 원래 값으로 복원
function SM_restoreCaptions(encList) {
    try {
        var list = eval("(" + decodeURIComponent(encList) + ")");
        var seqs = {}, ok = 0, miss = 0;
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var sq = app.project.sequences[i];
            try { seqs[String(sq.sequenceID)] = sq; } catch (e0) {}
        }
        for (var n = 0; n < list.length; n++) {
            var u = list[n], seq = seqs[u.seq], done = false;
            if (seq && u.t >= 0 && u.t < seq.videoTracks.numTracks) {
                var cl = seq.videoTracks[u.t].clips;
                for (var k = 0; k < cl.numItems && !done; k++) {
                    if (String(cl[k].start.ticks) !== String(u.s)) continue;
                    try { cl[k].components[u.c].properties[u.p].setValue(decodeURIComponent(u.raw), true); done = true; } catch (e1) {}
                }
            }
            if (done) ok++; else miss++;
        }
        return "ok:" + ok + "/" + list.length + (miss ? (" (못 찾음 " + miss + " — 클립을 옮기거나 지웠을 수 있어요)") : "");
    } catch (e) { return "err:" + e.toString(); }
}
