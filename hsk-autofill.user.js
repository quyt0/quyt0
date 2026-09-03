// ==UserScript==
// @name         HSK Autofill — Viện Khổng Tử (Google Forms)
// @namespace    https://github.com/local/hsk-autofill
// @version      1.4.0
// @description  Tự động điền form đăng ký dự thi HSK của Viện Khổng Tử trên Google Biểu mẫu. Nhận diện câu hỏi theo nội dung (giải mã Morse + mô tả) nên vẫn chạy đúng khi form xáo trộn thứ tự câu hỏi.
// @author       -
// @match        https://docs.google.com/forms/*
// @match        https://docs.google.com/a/*/forms/*
// @match        https://forms.gle/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════
   *  0. TIỆN ÍCH
   * ══════════════════════════════════════════════════════════════════ */

  const CFG_KEY   = 'hsk_autofill_cfg_v1';
  const RUN_KEY   = 'hsk_autofill_running';   // trạng thái chạy tự động
  const WHY_KEY   = 'hsk_autofill_why';       // lý do lần dừng gần nhất
  const OPEN_KEY  = 'hsk_autofill_open';      // bảng đang mở hay đang thu nhỏ
  const TRACE_KEY = 'hsk_autofill_trace';     // nhật ký sống xuyên trang

  /* ── Lưu trữ sống sót qua mỗi lần chuyển trang ────────────────────
   * Bấm "Tiếp" là Forms POST rồi tải lại cả trang, mọi biến trong bộ nhớ đều
   * mất. Thứ gì cần sống tiếp thì ghi vào CẢ sessionStorage LẪN localStorage:
   * sessionStorage đúng ngữ nghĩa hơn (chỉ trong tab này) nhưng có môi trường
   * làm mất nó lúc chuyển trang — mất cờ chạy là chế độ tự động chết giữa
   * chừng mà không báo gì. Bản trong localStorage có hạn dùng và khoá theo ID
   * form nên không sống dai ngoài ý muốn. Bọc try/catch vì có trình duyệt
   * chặn hẳn kho lưu.
   */
  function keep(key, val) {
    for (const st of [() => sessionStorage, () => localStorage]) {
      try { val === null ? st().removeItem(key) : st().setItem(key, val); }
      catch (e) { /* kho lưu bị chặn hoặc đầy */ }
    }
  }

  function recall(key) {
    for (const st of [() => sessionStorage, () => localStorage]) {
      try { const v = st().getItem(key); if (v != null) return v; } catch (e) { /* bị chặn */ }
    }
    return null;
  }

  /** Nhật ký xuyên trang — để xem lại chuyện gì đã xảy ra ở những trang trước. */
  function trace(msg) {
    let a = [];
    try { a = JSON.parse(recall(TRACE_KEY) || '[]'); } catch (e) { a = []; }
    a.push(new Date().toTimeString().slice(0, 8) + '  ' + msg);
    while (a.length > 80) a.shift();
    keep(TRACE_KEY, JSON.stringify(a));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Chờ tới khi điều kiện đúng (hoặc hết giờ). Trả về true/false.
   * Nhịp kiểm tra TĂNG DẦN 4ms → 25ms. Forms hầu như luôn đổi trạng thái
   * trong 1–2 khung hình, nên kiểm dày lúc đầu giúp thoát gần như tức thì
   * (nhịp cố định 50ms cũ luôn phí trọn 50ms cho mỗi lần chờ), mà vẫn không
   * ngốn CPU trong những lần hiếm hoi phải chờ lâu.
   */
  async function waitUntil(cond, ms = 900) {
    const t0 = Date.now();
    let step = 4;
    for (;;) {
      if (cond()) return true;
      if (Date.now() - t0 >= ms) return false;
      await sleep(step);
      if (step < 25) step = Math.min(25, step * 2);
    }
  }

  /**
   * Google Forms dùng jsaction nghe mousedown/mouseup/click trên widget tự
   * vẽ. Có lúc `.click()` đơn thuần không kích hoạt được nên phải bắn đủ
   * chuỗi sự kiện chuột.
   */
  function fireMouse(el) {
    if (!el) return;
    const o = { bubbles: true, cancelable: true, view: window, button: 0, composed: true };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) { /* trình duyệt cũ */ }
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) { /* trình duyệt cũ */ }
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  function fireKey(el, key, code) {
    const o = { bubbles: true, cancelable: true, key, code: key, keyCode: code, which: code };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  /**
   * Bấm cho tới khi ĐÚNG là đã đổi trạng thái. Thử `.click()` trước (tránh
   * bật/tắt hai lần), rồi mới tới chuỗi sự kiện chuột đầy đủ.
   * Luôn kiểm tra `ok()` trước khi bấm nên không bao giờ bấm thừa.
   */
  async function clickUntil(el, ok, tries = 3) {
    if (!el) return false;
    for (let i = 0; i < tries; i++) {
      if (ok()) return true;
      if (i === 0) el.click(); else fireMouse(el);
      // Lần đầu chỉ chờ ngắn: nếu widget không nghe `.click()` thì chờ lâu
      // cũng vô ích, chuyển sang chuỗi sự kiện chuột đầy đủ cho nhanh.
      if (await waitUntil(ok, i === 0 ? 250 : 700)) return true;
    }
    return ok();
  }

  /**
   * Mã định danh biểu mẫu đang mở. Chế độ tự động khoá theo mã này để không
   * bao giờ tự điền / tự bấm Tiếp trên một biểu mẫu khác.
   *
   * Phải đọc được MỌI dạng URL, vì Google đổi dạng ngay giữa chừng:
   *    mở link       →  /forms/d/e/<ID>/viewform
   *    bấm "Tiếp"    →  /forms/u/0/d/e/<ID>/formResponse   ← chèn thêm /u/0/
   *    tên miền riêng→  /a/<tên-miền>/forms/d/e/<ID>/viewform
   *    link rút gọn  →  forms.gle/<mã>   (đường dẫn không hề chứa ID)
   * Bản trước chỉ khớp được dạng đầu; từ trang 2 nó đọc ra một mã khác nên
   * tưởng là biểu mẫu lạ và tự tắt chế độ tự động ngay sau trang đầu tiên.
   *
   * Trả về TẤT CẢ mã đọc được: nếu bất kỳ mã nào trùng với mã lúc bấm ▶ thì
   * vẫn là đúng biểu mẫu đó.
   */
  const ID_RE = /\/forms(?:\/u\/\d+)?\/d\/(?:e\/)?([^/?#]+)/;

  function formIds() {
    const out = [];
    const add = (v) => { if (v && !out.includes(v)) out.push(v); };

    const m = location.pathname.match(ID_RE);
    add(m && m[1]);

    // Chắc chắn nhất: URL mà chính biểu mẫu gửi dữ liệu về. Nó giống hệt nhau
    // ở mọi trang, kể cả khi mở bằng link rút gọn forms.gle.
    for (const f of document.querySelectorAll('form[action]')) {
      const m2 = String(f.action).match(ID_RE);
      add(m2 && m2[1]);
    }

    if (!out.length) add(location.pathname);
    return out;
  }

  function formId() { return formIds()[0]; }

  /** Bỏ dấu tiếng Việt, hạ chữ thường, gom khoảng trắng. */
  function norm(s) {
    return (s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  const MORSE = {
    '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F',
    '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L',
    '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R',
    '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X',
    '-.--': 'Y', '--..': 'Z', '-----': '0', '.----': '1', '..---': '2',
    '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7',
    '---..': '8', '----.': '9'
  };

  /**
   * Tiêu đề câu hỏi trong form này bị mã hoá Morse để chặn autofill
   * (nhãn tiếng Việt thật chỉ là ảnh). Giải mã ngược lại thành từ khoá.
   */
  function morseDecode(raw) {
    const t = (raw || '').replace(/\s+/g, ' ').trim();
    if (!t || !/^[.\-\s/|]+$/.test(t)) return '';
    const words = t.split(/\s*[/|]\s*|\s{3,}/);
    let out = '';
    for (const w of words) {
      for (const c of w.trim().split(/\s+/)) {
        if (!c) continue;
        if (!MORSE[c]) return '';
        out += MORSE[c];
      }
    }
    return out;
  }

  /* ── Ghi giá trị vào <input> sao cho Google Forms nhận ── */
  const nativeInputSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  const nativeAreaSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  ).set;

  function setNativeValue(el, value) {
    const setter = el.tagName === 'TEXTAREA' ? nativeAreaSetter : nativeInputSetter;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function flash(el, color) {
    if (!el) return;
    const old = el.style.boxShadow;
    el.style.transition = 'box-shadow .2s';
    el.style.boxShadow = `0 0 0 2px ${color}`;
    setTimeout(() => { el.style.boxShadow = old; }, 1400);
  }

  /* ══════════════════════════════════════════════════════════════════
   *  1. ĐỊNH NGHĨA CÁC TRƯỜNG DỮ LIỆU
   *
   *  Mỗi trường có nhiều "khoá nhận diện":
   *    morse  — từ khoá sau khi giải mã Morse của tiêu đề  (điểm 100)
   *    title  — chuỗi con trong tiêu đề đã bỏ dấu          (điểm 60)
   *    desc   — chuỗi con trong phần mô tả                 (điểm 30)
   *  Nhờ vậy tool vẫn khớp đúng khi form thật đổi thứ tự / đổi entry ID.
   * ══════════════════════════════════════════════════════════════════ */

  const FIELDS = [
    // ── Thông tin thí sinh ───────────────────────────────────────────
    {
      key: 'hoTen', group: 'Thông tin thí sinh',
      label: 'HỌ TÊN THÍ SINH', hint: 'IN HOA, không dấu — VD: NGUYEN VAN A',
      kind: 'text', def: '',
      morse: ['NAME', 'FULLNAME', 'HOTEN', 'HOVATEN'],
      title: ['ho ten thi sinh', '考生姓名'],
      desc: ['nguyen tuan anh', 'khop voi ten tren cccd', '与身份证的名字一致']
    },
    {
      key: 'tenTrung', group: 'Thông tin thí sinh',
      label: 'TÊN TIẾNG TRUNG', hint: 'Không bắt buộc — VD: 阮俊英',
      kind: 'text', def: '', optional: true,
      morse: ['CHNAME', 'CNNAME', 'CHINESENAME'],
      title: ['ten tieng trung', '中文姓名'],
      desc: ['阮俊英']
    },
    {
      key: 'loaiGiayTo', group: 'Thông tin thí sinh',
      label: 'LOẠI GIẤY TỜ TÙY THÂN', hint: 'CCCD hoặc HỘ CHIẾU',
      kind: 'choice', def: 'CCCD',
      options: ['CCCD', 'HỘ CHIẾU'],
      title: ['loai giay to tuy than', '证件类型']
    },
    {
      key: 'soCccd', group: 'Thông tin thí sinh',
      label: 'SỐ CCCD', hint: '12 số, viết liền — VD: 033056789514',
      kind: 'text', def: '',
      morse: ['IDNUM', 'CCCD', 'IDNO'],
      title: ['so cccd', '身份证号码'],
      desc: ['12 so, viet lien', '12位数']
    },
    {
      key: 'soHoChieu', group: 'Thông tin thí sinh',
      label: 'SỐ HỘ CHIẾU', hint: 'Chỉ cần nếu chọn Hộ chiếu — VD: B1234567',
      kind: 'text', def: '', optional: true,
      morse: ['PPNUM', 'PASSPORT', 'PASSPORTNUM'],
      title: ['so ho chieu', '护照号码'],
      desc: ['b1234567']
    },
    {
      key: 'gioiTinh', group: 'Thông tin thí sinh',
      label: 'GIỚI TÍNH', hint: 'Nam hoặc Nữ',
      kind: 'choice', def: 'Nam',
      options: ['Nam', 'Nữ'],
      title: ['gioi tinh', '性别']
    },
    {
      key: 'ngaySinh', group: 'Thông tin thí sinh',
      label: 'NGÀY SINH', hint: 'NĂM-THÁNG-NGÀY — VD: 2001-11-20',
      kind: 'text', def: '',
      morse: ['BIRTHDATE', 'DOB', 'BIRTHDAY', 'NGAYSINH'],
      title: ['ngay sinh', '出生日期'],
      desc: ['2001-11-20']
    },
    {
      key: 'quocTich', group: 'Thông tin thí sinh',
      label: 'QUỐC TỊCH', hint: 'Để "Việt Nam", hoặc gõ quốc tịch khác',
      kind: 'choice', def: 'Việt Nam',
      options: ['Việt Nam'],
      title: ['quoc tich', '国籍']
    },
    {
      key: 'tiengMeDe', group: 'Thông tin thí sinh',
      label: 'TIẾNG MẸ ĐẺ', hint: 'Để "Tiếng Việt", hoặc gõ ngôn ngữ khác',
      kind: 'choice', def: 'Tiếng Việt',
      options: ['Tiếng Việt'],
      title: ['tieng me de', '母语']
    },
    {
      key: 'email', group: 'Thông tin thí sinh',
      label: 'EMAIL', hint: 'Chữ thường, tối đa 1 dấu "." — gmail/yahoo/outlook…',
      kind: 'text', def: '',
      morse: ['EMAIL', 'MAIL'],
      title: ['email', '邮箱'],
      desc: ['yeu cau ve dia chi email', '邮箱规格']
    },
    {
      key: 'sdt', group: 'Thông tin thí sinh',
      label: 'SỐ ĐIỆN THOẠI', hint: 'VD: 0830123456 hoặc +84830123456',
      kind: 'text', def: '',
      morse: ['PHONENUM', 'PHONE', 'TEL', 'SDT'],
      title: ['so dien thoai', '电话号码'],
      desc: ['0830123456']
    },
    {
      key: 'thoiGianHoc', group: 'Thông tin thí sinh',
      label: 'THỜI GIAN HỌC TIẾNG TRUNG', hint: 'VD: 3 năm',
      kind: 'choice', def: '1 năm',
      options: ['Dưới 6 tháng', '1 năm', '2 năm', '3 năm', '4 năm', '5 năm',
                '5-10 năm', '10 năm trở lên'],
      title: ['thoi gian hoc tieng trung', '学习中文年限']
    },

    // ── Tài khoản nộp lệ phí ─────────────────────────────────────────
    {
      key: 'phuongThuc', group: 'Tài khoản nộp lệ phí',
      label: 'PHƯƠNG THỨC CHUYỂN KHOẢN', hint: 'VD: E-BANKING',
      kind: 'choice', def: 'E-BANKING',
      options: ['CHUYỂN KHOẢN TẠI NGÂN HÀNG', 'E-BANKING',
                'CÁC NỀN TẢNG THANH TOÁN ONLINE KHÁC'],
      title: ['phuong thuc chuyen khoan', '缴费方式']
    },
    {
      key: 'soTaiKhoan', group: 'Tài khoản nộp lệ phí',
      label: 'SỐ TÀI KHOẢN', hint: 'Chuyển khoản tại quầy thì điền 0',
      kind: 'text', def: '',
      morse: ['ACCNUM', 'BANKNUM'],
      title: ['so tai khoan', '银行账号']
    },
    {
      key: 'chuTaiKhoan', group: 'Tài khoản nộp lệ phí',
      label: 'CHỦ TÀI KHOẢN', hint: 'IN HOA không dấu, có dấu cách',
      kind: 'text', def: '',
      morse: ['ACCNAME', 'OWNER'],
      title: ['chu tai khoan', '开户人']
    },
    {
      key: 'tenNganHang', group: 'Tài khoản nộp lệ phí',
      label: 'TÊN NGÂN HÀNG', hint: 'Ngân hàng khác → gõ tên, tool tự chọn "Mục khác"',
      kind: 'choice', def: 'VIETCOMBANK',
      options: ['AGRIBANK', 'BIDV', 'MB BANK', 'VP BANK', 'TP BANK',
                'TECHCOMBANK', 'VIETCOMBANK', 'VIETINBANK'],
      title: ['ten ngan hang', '银行名称']
    },

    // ── Khác ─────────────────────────────────────────────────────────
    {
      key: 'xacThuc', group: 'Khác',
      label: 'CÂU HỎI XÁC THỰC', hint: 'Bỏ trống → tool tự đoán từ gợi ý "ĐÁP ÁN LÀ …"',
      kind: 'text', def: '', optional: true,
      title: ['cau hoi xac thuc', 'nam nay la nam bao nhieu', '今年是哪一年',
              '验证问题']
    }
  ];

  const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

  /** Câu "TÔI CAM KẾT" — 2 lựa chọn chỉ là 2 ngôn ngữ của cùng 1 nội dung. */
  const COMMIT_MATCH = ['toi cam ket', '本人保证'];

  /* ══════════════════════════════════════════════════════════════════
   *  2. CẤU HÌNH (lưu vào localStorage)
   * ══════════════════════════════════════════════════════════════════ */

  function loadCfg() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { /* ignore */ }
    const cfg = {
      data: {}, autoSubmit: false, autoCommit: true, emailReceipt: true, speed: 120
    };
    for (const f of FIELDS) cfg.data[f.key] = f.def;
    Object.assign(cfg, saved, { data: Object.assign(cfg.data, saved.data || {}) });
    return cfg;
  }

  function saveCfg(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }

  let CFG = loadCfg();

  /* ══════════════════════════════════════════════════════════════════
   *  3. ĐỌC CÁC CÂU HỎI TRÊN TRANG
   * ══════════════════════════════════════════════════════════════════ */

  const TYPE = {
    0: 'text', 1: 'para', 2: 'radio', 3: 'dropdown', 4: 'checkbox',
    5: 'scale', 6: 'block', 7: 'grid', 8: 'page', 9: 'date', 10: 'time',
    13: 'file'
  };

  /**
   * data-params có dạng  %.@.[ …mảng câu hỏi… ],"i40","i41",…
   * (còn tham số thừa phía sau) nên phải cắt đúng mảng cân bằng ngoặc
   * trước khi JSON.parse.
   */
  function balancedArray(t) {
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return t.slice(0, i + 1); }
    }
    return t;
  }

  function readQuestions() {
    const out = [];
    for (const el of document.querySelectorAll('div[role="listitem"]')) {
      // Bỏ qua các listitem không phải câu hỏi (vd: thẻ tệp đã tải lên nằm
      // lồng bên trong câu hỏi dạng file).
      if (!el.querySelector('[data-params]') && !el.querySelector('[role="heading"]')) continue;
      const model = el.querySelector('[data-params]') || el;
      let title = '', desc = '', type = null, required = false;

      const raw = model.getAttribute && model.getAttribute('data-params');
      if (raw) {
        try {
          const p = JSON.parse(balancedArray(raw.replace(/^%\.@\./, '')));
          title = p[1] || '';
          desc = p[2] || '';
          type = TYPE[p[3]] || null;
          const entry = (p[4] || [])[0];
          required = !!(entry && entry[2]);
        } catch (e) { /* rơi xuống đọc từ DOM */ }
      }

      if (!title) {
        const h = el.querySelector('[role="heading"]');
        if (h) title = (h.querySelector('.M7eMe') || h).textContent || '';
        const d = el.querySelector('.gubaDc');
        if (d) desc = d.textContent || '';
        required = !!el.querySelector('[aria-label*="bắt buộc"], [aria-required="true"]');
      }

      if (!type) {
        if (el.querySelector('[role="listbox"]')) type = 'dropdown';
        else if (el.querySelector('[role="radiogroup"]')) type = 'radio';
        else if (el.querySelector('[role="checkbox"]')) type = 'checkbox';
        else if (el.querySelector('textarea')) type = 'para';
        else if (el.querySelector('input[type="text"]')) type = 'text';
        else if (el.querySelector('[jsname="mWZCyf"]')) type = 'file';
        else type = 'block';
      }

      if (type === 'block') continue;

      out.push({
        el, type, required,
        title: title.replace(/<[^>]*>/g, ''),
        desc: desc.replace(/<[^>]*>/g, ''),
        nTitle: norm(title),
        nDesc: norm(desc),
        morse: morseDecode(title)
      });
    }
    return out;
  }

  /** Chấm điểm mức khớp giữa 1 câu hỏi và 1 trường dữ liệu. */
  function score(q, f) {
    if (f.morse && q.morse && f.morse.includes(q.morse)) return 100;
    if (f.title && f.title.some((t) => q.nTitle.includes(norm(t)))) return 60;
    if (f.desc && f.desc.some((d) => q.nDesc.includes(norm(d)))) return 30;
    return 0;
  }

  /** Ghép câu hỏi ↔ trường, mỗi trường dùng cho câu khớp mạnh nhất. */
  function matchAll(questions) {
    const pairs = [];
    for (const q of questions) {
      for (const f of FIELDS) {
        const s = score(q, f);
        if (s > 0) pairs.push({ q, f, s });
      }
    }
    pairs.sort((a, b) => b.s - a.s);
    const usedQ = new Set(), usedF = new Set(), res = [];
    for (const p of pairs) {
      if (usedQ.has(p.q) || usedF.has(p.f.key)) continue;
      usedQ.add(p.q); usedF.add(p.f.key); res.push(p);
    }
    return res;
  }

  /* ══════════════════════════════════════════════════════════════════
   *  4. ĐIỀN TỪNG LOẠI CÂU HỎI
   * ══════════════════════════════════════════════════════════════════ */

  /** Chọn option gần đúng nhất với giá trị người dùng nhập. */
  function pickOption(values, want) {
    const w = norm(want);
    if (!w) return null;
    const segs = (v) => norm(v).split(/[|｜/]/).map((s) => s.trim()).filter(Boolean);

    for (const v of values) if (segs(v).includes(w)) return v;          // khớp 1 vế
    for (const v of values) if (norm(v) === w) return v;                // khớp cả chuỗi
    for (const v of values) if (segs(v).some((s) => s.startsWith(w))) return v;
    for (const v of values) if (norm(v).includes(w)) return v;
    for (const v of values) if (w.includes(norm(v)) && norm(v).length > 2) return v;
    return null;
  }

  function fillText(q, value) {
    const inp = q.el.querySelector('textarea, input[type="text"], input[type="email"]');
    if (!inp) return false;
    setNativeValue(inp, value);
    inp.dispatchEvent(new Event('blur', { bubbles: true }));
    flash(inp, '#22c55e');
    return true;
  }

  const isChecked = (el) => !!el && el.getAttribute('aria-checked') === 'true';

  /**
   * Câu "TÔI CAM KẾT" có hai lựa chọn là HAI NGÔN NGỮ của cùng một nội dung:
   *    "Tôi cam kết không thuê người đăng ký dự thi kỳ thi lần này."
   *    "本人保证未雇用他人代替报名本次考试。"
   * Phải tích dòng tiếng Việt. KHÔNG dựa vào thứ tự lựa chọn: biểu mẫu này đã
   * xáo trộn thứ tự câu hỏi, và Google Forms cũng cho xáo trộn thứ tự lựa chọn,
   * nên "dòng đầu tiên" hoàn toàn có thể là dòng tiếng Trung.
   */
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  function pickVietnamese(values) {
    if (!values.length) return null;
    // Chữ Latin ⇒ nhiều khả năng là tiếng Việt; chữ Hán ⇒ loại.
    const score = (v) => (/[a-zA-Z]/.test(v) ? 2 : 0) - (CJK_RE.test(v) ? 3 : 0);
    return values.reduce((best, v) => (score(v) > score(best) ? v : best), values[0]);
  }

  async function fillRadio(q, value) {
    const radios = [...q.el.querySelectorAll('[role="radio"][data-value]')];
    if (!radios.length) return false;
    const normal = radios.filter((r) => r.dataset.value !== '__other_option__');
    const other = radios.find((r) => r.dataset.value === '__other_option__');

    let target = null;
    if (value) target = pickOption(normal.map((r) => r.dataset.value), value);

    // Không truyền giá trị (câu "TÔI CAM KẾT") ⇒ chọn dòng tiếng Việt.
    if (target === null && !value && normal.length)
      target = pickVietnamese(normal.map((r) => r.dataset.value));

    if (target !== null) {
      const el = normal.find((r) => r.dataset.value === target);
      const ok = await clickUntil(el, () => isChecked(el));
      flash(el, ok ? '#22c55e' : '#ef4444');
      return ok;
    }
    if (value && other) {                       // không có sẵn → dùng "Mục khác"
      const ok = await clickUntil(other, () => isChecked(other));
      const inp = q.el.querySelector('input[type="text"]');
      if (inp) setNativeValue(inp, value);
      flash(other, ok ? '#f59e0b' : '#ef4444');
      return ok && !!inp;
    }
    return false;
  }

  /** Giá trị đang được chọn của một dropdown ('' nếu chưa chọn gì). */
  function dropdownValue(q) {
    const o = q.el.querySelector('[role="option"][aria-selected="true"][data-value]');
    return o ? (o.getAttribute('data-value') || '') : '';
  }

  async function fillDropdown(q, value) {
    const lb = q.el.querySelector('[role="listbox"]');
    if (!lb) return false;
    const inline = [...lb.querySelectorAll('[role="option"]')]
      .filter((o) => o.getAttribute('data-value'));
    const target = pickOption(inline.map((o) => o.getAttribute('data-value')), value);
    if (target === null) return false;

    const done = () => dropdownValue(q) === target;
    if (done()) { flash(lb, '#22c55e'); return true; }

    // Cách 1: mở danh sách rồi bấm đúng mục. Sau khi mở, Forms có thể vẽ lại
    // danh sách ở lớp phủ khác, nên tìm phần tử ĐANG HIỂN THỊ trên toàn trang.
    const optNow = () => {
      const all = [...document.querySelectorAll('[role="option"][data-value]')]
        .filter((o) => o.getAttribute('data-value') === target);
      return all.reverse().find((o) => o.getClientRects().length) ||
             inline.find((o) => o.getAttribute('data-value') === target);
    };
    const expanded = () => lb.getAttribute('aria-expanded') === 'true';
    const optReady = () => { const o = optNow(); return !!o && !!o.getClientRects().length; };
    for (let i = 0; i < 2 && !done(); i++) {
      if (!expanded()) {
        if (i === 0) lb.click(); else fireMouse(lb);
        await waitUntil(expanded, 500);
        // Chờ ĐÚNG mục cần chọn hiện ra, thay vì ngủ cứng 80ms: menu thường
        // vẽ xong ngay trong khung hình kế tiếp nên bước này gần như 0ms.
        await waitUntil(optReady, 250);
      }
      const opt = optNow();
      if (i === 0) opt.click(); else fireMouse(opt);
      await waitUntil(done, i === 0 ? 350 : 800);
    }
    if (done()) { flash(lb, '#22c55e'); return true; }

    // Cách 2: bàn phím. Đi xuống từng bước và DỪNG NGAY khi trúng mục cần
    // chọn, nên không bao giờ dừng ở một lựa chọn sai.
    lb.focus();
    for (let i = 0; i < inline.length + 2 && !done(); i++) {
      fireKey(lb, 'ArrowDown', 40);
      await waitUntil(done, 120);
    }
    if (done()) { flash(lb, '#22c55e'); return true; }

    console.warn('[HSK Autofill] không chọn được dropdown:', q.title,
      '| cần:', target, '| đang là:', dropdownValue(q),
      '| các lựa chọn:', inline.map((o) => o.getAttribute('data-value')));
    flash(lb, '#ef4444');
    return false;
  }

  async function fillCheckbox(q, value) {
    const boxes = [...q.el.querySelectorAll('[role="checkbox"][data-value]')];
    if (!boxes.length) return false;
    const wants = String(value).split(/\s*[;,]\s*/).filter(Boolean);
    let ok = false;
    for (const w of wants) {
      const t = pickOption(boxes.map((b) => b.dataset.value), w);
      if (t === null) continue;
      const el = boxes.find((b) => b.dataset.value === t);
      const hit = await clickUntil(el, () => isChecked(el));
      flash(el, hit ? '#22c55e' : '#ef4444');
      ok = ok || hit;
    }
    return ok;
  }

  /**
   * Ô "Lưu lại <email> dưới dạng email để thêm vào câu trả lời của tôi"
   * ở trang đầu. Nó KHÔNG nằm trong div[role="listitem"] như các câu hỏi
   * khác (Google vẽ riêng ở khối [data-user-email-address]) nên phải tìm
   * và tích riêng.
   */
  async function fillEmailReceipt() {
    const boxes = [...document.querySelectorAll('[role="checkbox"]')].filter((b) => {
      if (b.hasAttribute('data-value')) return false;         // là lựa chọn của câu hỏi thường
      if (b.closest('[data-user-email-address]')) return true;
      const lb = norm(b.getAttribute('aria-label') || '');
      return lb.includes('duoi dang email') || lb.includes('as the email');
    });
    let done = 0;
    for (const b of boxes) {
      if (isChecked(b)) { done++; continue; }
      const ok = await clickUntil(b, () => isChecked(b));
      flash(b, ok ? '#22c55e' : '#ef4444');
      if (ok) done++;
    }
    return { total: boxes.length, done };
  }

  /** Đoán đáp án câu xác thực từ chính phần mô tả của câu hỏi. */
  function guessVerify(q) {
    const t = q.title + '\n' + q.desc;
    let m = t.match(/Đ[ÁA]P\s*[ÁA]N\s*(?:L[ÀA]|:)\s*[:：]?\s*([^\s\n]+)/i)
         || t.match(/答案\s*[是为:：]\s*([^\s\n]+)/);
    if (m) return m[1].replace(/[.,。，]$/, '');
    if (/nam nay|今年/.test(norm(t))) return String(new Date().getFullYear());
    return '';
  }

  /* ── Kiểm tra 1 câu hỏi đã có đáp án chưa ── */
  function isAnswered(q) {
    switch (q.type) {
      case 'text': case 'para': case 'date': case 'time': {
        const i = q.el.querySelector('textarea, input[type="text"], input[type="email"]');
        return !!(i && i.value.trim());
      }
      case 'radio':
        return !!q.el.querySelector('[role="radio"][aria-checked="true"]');
      case 'checkbox':
        return !!q.el.querySelector('[role="checkbox"][aria-checked="true"]');
      case 'dropdown': {
        const o = q.el.querySelector('[role="option"][aria-selected="true"]');
        return !!(o && o.getAttribute('data-value'));
      }
      case 'file': {
        // Forms thêm thẻ tệp có data-id (id trên Drive) vào danh sách
        // "Các tệp đã chọn" NGAY SAU KHI tải lên xong.
        const list = q.el.querySelector('[jsname="kTlJSc"]');
        if (list && list.querySelector('[data-id]')) return true;
        return !!q.el.querySelector('[role="listitem"] [data-view-file-link], [role="listitem"][data-tooltip]');
      }
      default:
        return true;
    }
  }

  /* ══════════════════════════════════════════════════════════════════
   *  5. ĐIỀN CẢ TRANG
   * ══════════════════════════════════════════════════════════════════ */

  async function fillPage() {
    const qs = readQuestions();
    const matched = matchAll(qs);
    const report = { filled: [], skipped: [], missing: [], needFile: false };
    const handled = new Set();

    for (const { q, f } of matched) {
      const value = (CFG.data[f.key] || '').trim();
      handled.add(q);

      if (f.key === 'xacThuc' && !value) {
        const guess = guessVerify(q);
        if (guess) {
          fillText(q, guess);
          report.filled.push(`${f.label} → ${guess} (tự đoán)`);
          continue;
        }
      }
      if (!value && f.optional) { report.skipped.push(f.label); continue; }

      let ok = false;
      if (q.type === 'text' || q.type === 'para' || q.type === 'date') ok = fillText(q, value);
      else if (q.type === 'radio') ok = await fillRadio(q, value);
      else if (q.type === 'dropdown') ok = await fillDropdown(q, value);
      else if (q.type === 'checkbox') ok = await fillCheckbox(q, value);

      if (ok) report.filled.push(`${f.label} → ${value || '(mặc định)'}`);
      else report.missing.push(f.label);
      // Mọi widget đều đã được XÁC MINH trạng thái ở trên rồi, nên chỉ cần
      // nhường 1 khung hình cho Forms, không phải ngủ theo `speed` nữa.
      await sleep(8);
    }

    // Câu "TÔI CAM KẾT" — 2 phương án là 2 ngôn ngữ của cùng nội dung.
    if (CFG.autoCommit) {
      for (const q of qs) {
        if (handled.has(q) || q.type !== 'radio') continue;
        if (!COMMIT_MATCH.some((k) => q.nTitle.includes(norm(k)))) continue;
        handled.add(q);
        if (await fillRadio(q, '')) {
          const da = q.el.querySelector('[role="radio"][aria-checked="true"]');
          report.filled.push('TÔI CAM KẾT → ' +
            ((da && da.getAttribute('data-value')) || '(đồng ý)').slice(0, 45));
        }
      }
    }

    // Ô "Lưu lại <email> dưới dạng email…" ở trang đầu (nằm ngoài danh sách
    // câu hỏi nên xử lý riêng).
    if (CFG.emailReceipt) {
      const r = await fillEmailReceipt();
      if (r.done) report.filled.push('Lưu email vào câu trả lời → đã tích');
      else if (r.total) report.missing.push('Ô "Lưu lại … dưới dạng email"');
    }

    // Cho Forms kịp cập nhật aria-* trước khi kết luận là còn thiếu — nhưng
    // thoát NGAY khi mọi câu bắt buộc đã có đáp án (đường chạy thường gặp),
    // chỉ thật sự chờ khi còn câu trông như bỏ trống.
    await waitUntil(
      () => qs.every((q) => !q.required || q.type === 'file' || isAnswered(q)), 260);

    // Câu bắt buộc còn bỏ trống mà tool không nhận diện được.
    for (const q of qs) {
      if (!q.required || isAnswered(q)) continue;
      if (q.type === 'file') { report.needFile = true; continue; }

      // Dự phòng cho form thật: câu tự luận ngắn lạ mà chưa ai nhận →
      // thử đoán đáp án từ mô tả, rồi mới đến ô "CÂU HỎI XÁC THỰC".
      if (q.type === 'text' || q.type === 'para') {
        const fallback = guessVerify(q) || (CFG.data.xacThuc || '').trim();
        if (fallback && fillText(q, fallback)) {
          report.filled.push(`${(q.title || 'câu hỏi lạ').slice(0, 30)} → ${fallback} (dự phòng)`);
          continue;
        }
      }
      const name = q.morse || q.title.replace(/\n/g, ' ').slice(0, 40) || '(không rõ)';
      if (!report.missing.includes(name)) report.missing.push(name);
      flash(q.el, '#ef4444');
    }
    return report;
  }

  /* ══════════════════════════════════════════════════════════════════
   *  6. NÚT ĐIỀU HƯỚNG
   * ══════════════════════════════════════════════════════════════════ */

  const btnNext   = () => document.querySelector('[role="button"][jsname="OCpkoe"]');
  const btnSubmit = () => document.querySelector('[role="button"][jsname="M2UYVd"]');
  const btnBack   = () => document.querySelector('[role="button"][jsname="GeGHKb"]');

  /* ══════════════════════════════════════════════════════════════════
   *  7. GIAO DIỆN
   * ══════════════════════════════════════════════════════════════════ */

  const CSS = `
  #hskaf, #hskaf-pill { font-family: system-ui, "Segoe UI", Roboto, sans-serif; }
  #hskaf-pill {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
    background: #0f766e; color: #fff; border-radius: 999px; cursor: pointer;
    padding: 10px 16px; font-size: 13px; font-weight: 700; letter-spacing: .3px;
    box-shadow: 0 4px 14px rgba(0,0,0,.28); user-select: none;
  }
  #hskaf {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483001;
    width: 360px; max-height: calc(100vh - 32px); display: flex; flex-direction: column;
    background: #fff; color: #111827; border-radius: 12px; overflow: hidden;
    box-shadow: 0 10px 40px rgba(0,0,0,.3); font-size: 13px;
  }
  #hskaf header {
    background: #0f766e; color: #fff; padding: 10px 12px; display: flex;
    align-items: center; gap: 8px; cursor: move;
  }
  #hskaf header b { font-size: 13px; flex: 1; }
  #hskaf header span { cursor: pointer; opacity: .85; padding: 0 4px; }
  #hskaf .body { overflow-y: auto; padding: 10px 12px; }
  #hskaf .grp { font-size: 11px; font-weight: 700; text-transform: uppercase;
    color: #0f766e; margin: 12px 0 6px; letter-spacing: .5px; }
  #hskaf .grp:first-child { margin-top: 0; }
  #hskaf label { display: block; margin-bottom: 8px; }
  #hskaf label .t { font-weight: 600; display: block; margin-bottom: 2px; }
  #hskaf label .h { color: #6b7280; font-size: 11px; display: block; margin-bottom: 3px; }
  #hskaf input[type=text] {
    width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px;
    border: 1px solid #d1d5db; border-radius: 6px; background: #fff; color: #111827;
  }
  #hskaf input[type=text]:focus { outline: 2px solid #14b8a6; outline-offset: -1px; }
  #hskaf .opts { border-top: 1px solid #e5e7eb; margin-top: 10px; padding-top: 8px; }
  #hskaf .opts label { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  #hskaf footer { border-top: 1px solid #e5e7eb; padding: 8px 12px; display: flex;
    gap: 6px; flex-wrap: wrap; background: #f9fafb; }
  #hskaf button {
    flex: 1; min-width: 96px; padding: 7px 8px; font-size: 12px; font-weight: 600;
    border: 0; border-radius: 6px; cursor: pointer; background: #e5e7eb; color: #111827;
  }
  #hskaf button.p { background: #0f766e; color: #fff; }
  #hskaf button.d { background: #b91c1c; color: #fff; }
  #hskaf button:hover { filter: brightness(1.08); }
  #hskaf .log {
    margin: 8px 12px; padding: 8px; border-radius: 6px; background: #f3f4f6;
    font-size: 11px; line-height: 1.5; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word;
    /* Cao gấp đôi trước đây, và kéo được mép dưới để xem thoải mái hơn. */
    min-height: 92px; height: 168px; max-height: 60vh; resize: vertical;
    flex: 0 0 auto;
  }
  #hskaf .log.warn { background: #fef3c7; }
  #hskaf .log.err  { background: #fee2e2; }
  `;

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k);
    return e;
  }

  let panel, pill, logBox;

  function log(msg, cls) {
    if (!logBox) return;
    logBox.className = 'log' + (cls ? ' ' + cls : '');
    logBox.textContent = msg;
    // Phần cần đọc nhất luôn nằm ở CUỐI (⏸ đang chờ tải ảnh, ⚠ chưa điền được,
    // dòng nhật ký mới nhất), nên tự cuộn xuống đáy thay vì bắt người dùng kéo.
    logBox.scrollTop = logBox.scrollHeight;
  }

  /**
   * Mở / thu nhỏ bảng, có NHỚ LẠI qua các lần chuyển trang.
   * Mỗi lần bấm "Tiếp" là trang tải lại từ đầu, bảng dựng lại mặc định là thu
   * nhỏ — người dùng phải bấm mở lại ở từng trang. Ghi lựa chọn xuống kho lưu
   * để trang sau tự mở đúng như lúc rời trang trước.
   */
  function setOpen(open) {
    if (!panel) return;
    panel.style.display = open ? 'flex' : 'none';
    pill.style.display = open ? 'none' : 'block';
    keep(OPEN_KEY, open ? '1' : '0');
  }

  const isOpen = () => !!panel && panel.style.display !== 'none';

  /** Hiện nhật ký của cả lượt chạy, kể cả những trang đã rời khỏi. */
  function showTrace() {
    let a = [];
    try { a = JSON.parse(recall(TRACE_KEY) || '[]'); } catch (e) { a = []; }
    if (!a.length) { log('Nhật ký trống — chưa chạy tự động lần nào.'); return; }
    const text = 'NHẬT KÝ (cũ → mới):\n' + a.join('\n');
    log(text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => log(text + '\n\n✓ Đã sao chép — có thể dán để gửi đi.'))
        .catch(() => { /* trình duyệt không cho ghi clipboard */ });
    }
  }

  function buildUI() {
    document.head.append(h('style', {}, CSS));

    pill = h('div', {
      id: 'hskaf-pill',
      onclick: () => setOpen(true)
    }, '⚡ HSK Autofill');

    const body = h('div', { class: 'body' });
    let lastGroup = null;
    for (const f of FIELDS) {
      if (f.group !== lastGroup) {
        lastGroup = f.group;
        body.append(h('div', { class: 'grp' }, f.group));
      }
      const listId = 'hskaf-dl-' + f.key;
      const inp = h('input', {
        type: 'text', id: 'hskaf-' + f.key,
        placeholder: f.optional ? '(để trống nếu không dùng)' : '',
        ...(f.options ? { list: listId } : {})
      });
      inp.value = CFG.data[f.key] || '';
      inp.addEventListener('input', () => {
        CFG.data[f.key] = inp.value; saveCfg(CFG);
      });
      body.append(h('label', {},
        h('span', { class: 't' }, f.label),
        h('span', { class: 'h' }, f.hint || ''),
        inp,
        f.options ? h('datalist', { id: listId },
          f.options.map((o) => h('option', { value: o }))) : null
      ));
    }

    const cbCommit = h('input', { type: 'checkbox' });
    cbCommit.checked = CFG.autoCommit;
    cbCommit.addEventListener('change', () => { CFG.autoCommit = cbCommit.checked; saveCfg(CFG); });

    const cbMail = h('input', { type: 'checkbox' });
    cbMail.checked = CFG.emailReceipt;
    cbMail.addEventListener('change', () => { CFG.emailReceipt = cbMail.checked; saveCfg(CFG); });

    const cbSubmit = h('input', { type: 'checkbox' });
    cbSubmit.checked = CFG.autoSubmit;
    cbSubmit.addEventListener('change', () => { CFG.autoSubmit = cbSubmit.checked; saveCfg(CFG); });

    body.append(h('div', { class: 'opts' },
      h('label', {}, cbCommit, 'Tự tích các ô "TÔI CAM KẾT"'),
      h('label', {}, cbMail, 'Tự tích ô "Lưu lại … dưới dạng email"'),
      h('label', {}, cbSubmit, 'Tự bấm GỬI ở trang cuối (⚠ gửi thật)')
    ));

    logBox = h('div', { class: 'log' }, 'Sẵn sàng. Bấm "Điền + Tiếp" để chạy từng trang, hoặc "Chạy tự động".');

    const foot = h('footer', {},
      h('button', { class: 'p', onclick: () => fillOnly() }, 'Chỉ điền'),
      h('button', { class: 'p', onclick: () => stepOnce() }, 'Điền + Tiếp'),
      h('button', { onclick: () => startAuto() }, '▶ Chạy tự động'),
      h('button', { class: 'd', onclick: () => stopAuto('Đã dừng.') }, '■ Dừng'),
      h('button', { title: 'Xem lại chuyện đã xảy ra ở các trang trước',
                    onclick: () => showTrace() }, '📋 Nhật ký')
    );

    const head = h('header', {},
      h('b', {}, '⚡ HSK Autofill'),
      h('span', { title: 'Thu nhỏ', onclick: () => setOpen(false) }, '—')
    );

    panel = h('div', { id: 'hskaf' }, head, body, logBox, foot);
    panel.style.display = 'none';
    document.body.append(pill, panel);
    makeDraggable(panel, head);
    // Mở lại đúng như lúc rời trang trước (mặc định lần đầu là thu nhỏ).
    setOpen(recall(OPEN_KEY) === '1');
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, on = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'SPAN') return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = ox + 'px'; el.style.top = oy + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!on) return;
      el.style.left = (ox + e.clientX - sx) + 'px';
      el.style.top = (oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { on = false; });
  }

  /* ══════════════════════════════════════════════════════════════════
   *  8. ĐIỀU KHIỂN
   * ══════════════════════════════════════════════════════════════════ */

  function describe(r) {
    const L = [];
    if (r.filled.length) L.push('✅ Đã điền:\n  • ' + r.filled.join('\n  • '));
    if (r.skipped.length) L.push('➖ Bỏ qua (trống): ' + r.skipped.join(', '));
    if (r.needFile) L.push('📎 Cần TỰ TẢI ẢNH giấy tờ lên (trình duyệt không cho script làm việc này).');
    if (r.missing.length) L.push('⚠ Chưa điền được: ' + r.missing.join(', '));
    return L.join('\n\n') || 'Trang này không có câu hỏi nào cần điền.';
  }

  async function fillOnly() {
    const r = await fillPage();
    log(describe(r), r.missing.length || r.needFile ? 'warn' : '');
    return r;
  }

  async function stepOnce() {
    const r = await fillPage();
    if (r.needFile || r.missing.length) {
      log(describe(r) + '\n\n⏸ Dừng lại — hãy xử lý các mục trên rồi bấm lại.', 'warn');
      return false;
    }
    log(describe(r) + '\n\n➡ Đang chuyển trang…');
    await sleep(Math.max(60, CFG.speed | 0));
    return goNext();
  }

  function goNext() {
    const sub = btnSubmit();
    if (sub) {
      if (!CFG.autoSubmit) {
        log('🏁 Đây là trang cuối. Bật "Tự bấm GỬI" hoặc tự bấm nút Gửi.', 'warn');
        flash(sub, '#0f766e');
        return false;
      }
      sub.click();
      return true;
    }
    const nx = btnNext();
    if (!nx) { log('Không tìm thấy nút Tiếp/Gửi.', 'err'); return false; }
    nx.click();
    return true;
  }

  /* Một lượt chạy tự động chỉ sống 15 phút: đủ dài cho 8 trang kể cả lúc dừng
     chờ tải ảnh, nhưng không để sót cờ khiến hôm sau mở form lại tự chạy. */
  const RUN_TTL = 15 * 60 * 1000;

  /** Trạng thái chạy tự động của ĐÚNG biểu mẫu này, hoặc null. */
  function readRun() {
    let st = null;
    try { st = JSON.parse(recall(RUN_KEY) || 'null'); } catch (e) { st = null; }
    if (!st || !formIds().includes(st.id) || Date.now() - st.t > RUN_TTL) return null;
    return st;
  }

  function writeRun(st) { keep(RUN_KEY, JSON.stringify(st)); }

  function isRunning() { return !!readRun(); }

  function startAuto() {
    keep(WHY_KEY, null);
    keep(TRACE_KEY, null);
    writeRun({ id: formId(), t: Date.now(), hops: 0 });
    trace('▶ bật chế độ tự động');
    log('▶ Chế độ tự động: BẬT');
    autoTick();
  }

  function stopAuto(msg) {
    keep(RUN_KEY, null);
    trace('■ DỪNG — ' + (msg ? msg.replace(/\s+/g, ' ').slice(0, 140) : 'không rõ lý do'));
    if (!msg) return;
    log(msg, 'warn');
    // Ghi lại lý do: nếu việc dừng xảy ra ngay lúc trang đang chuyển, thông báo
    // trên màn hình sẽ chết theo trang cũ. Trang sau mở lên sẽ đọc và hiện lại,
    // để không bao giờ có kiểu "tự nhiên đứng im mà không nói gì".
    keep(WHY_KEY, msg);
  }

  async function autoTick() {
    const st = readRun();
    if (!st) { trace('autoTick bị gọi nhưng cờ chạy không còn'); return; }
    if (st.hops > 25) { stopAuto('Đã đi quá 25 trang — dừng để tránh lặp vô hạn.'); return; }
    // Gia hạn ở MỖI trang để một lượt chạy dài không hết hạn giữa chừng.
    writeRun({ ...st, t: Date.now() });
    trace('trang ' + (st.hops + 1) + ': bắt đầu điền');

    const r = await fillPage();
    trace('trang ' + (st.hops + 1) + ': điền ' + r.filled.length + ' mục' +
          (r.missing.length ? ' | THIẾU: ' + r.missing.join(', ') : '') +
          (r.needFile ? ' | cần tải ảnh' : ''));

    if (r.needFile) {
      log(describe(r) + '\n\n⏸ ĐANG CHỜ BẠN TẢI ẢNH LÊN. Tải xong tool sẽ tự đi tiếp.', 'warn');
      waitForFile();
      return;
    }
    if (r.missing.length) {
      stopAuto(describe(r) + '\n\n⏸ Dừng tự động: có mục bắt buộc chưa điền được.');
      return;
    }

    const sub = btnSubmit();
    if (sub && !CFG.autoSubmit) {
      stopAuto(describe(r) + '\n\n🏁 Trang cuối — tự bấm GỬI đang TẮT. Bạn tự bấm nút Gửi nhé.');
      flash(sub, '#0f766e');
      return;
    }

    log(describe(r) + '\n\n➡ Chuyển trang…');
    writeRun({ ...st, t: Date.now(), hops: st.hops + 1 });
    await sleep(Math.max(60, CFG.speed | 0));
    const sig = pageSignature();
    if (!goNext()) { stopAuto('Không bấm được nút Tiếp/Gửi.'); return; }
    trace('đã bấm Tiếp, đang chờ trang mới');

    // Nếu một lúc sau vẫn ở nguyên trang → có lỗi xác thực, dừng lại báo người dùng.
    //
    // PHẢI huỷ ngay khi trình duyệt bắt đầu rời trang. Bấm "Tiếp" là gửi POST
    // rồi tải lại cả trang; trong lúc chờ máy chủ trả lời, trang cũ VẪN SỐNG và
    // chữ ký trang vẫn y nguyên. Mạng chậm hơn mốc chờ là hàm này chạy, xoá cờ
    // chạy trong sessionStorage — mà cờ đó sống xuyên trang, nên trang sau mở
    // lên là nằm im, còn lời cảnh báo thì chết theo trang cũ ⇒ "dừng luôn" mà
    // không báo gì. Đó chính là lỗi dừng ở trang 2.
    const guard = setTimeout(() => {
      if (!isRunning()) return;
      if (pageSignature() !== sig) return;
      const errs = [...document.querySelectorAll('[role="alert"]')]
        .map((e) => e.textContent.trim()).filter(Boolean);
      stopAuto('⏸ Không chuyển được trang.\n' +
        (errs.length ? 'Lỗi từ form:\n  • ' + errs.join('\n  • ')
                     : 'Có thể một câu bắt buộc chưa hợp lệ.'));
    }, 8000);
    const cancelGuard = () => clearTimeout(guard);
    addEventListener('beforeunload', cancelGuard, { once: true });
    addEventListener('pagehide', cancelGuard, { once: true });
  }

  function pageSignature() {
    return [...document.querySelectorAll('[data-params]')]
      .map((e) => (e.getAttribute('data-params') || '').slice(0, 40)).join('|');
  }

  /** Chờ người dùng tự tải tệp lên rồi chạy tiếp. */
  function waitForFile() {
    const iv = setInterval(() => {
      if (!isRunning()) { clearInterval(iv); return; }
      const pending = readQuestions()
        .some((q) => q.type === 'file' && q.required && !isAnswered(q));
      if (!pending) {
        clearInterval(iv);
        log('📎 Đã nhận tệp — tiếp tục…');
        setTimeout(autoTick, 500);
      }
    }, 800);
  }

  /* ══════════════════════════════════════════════════════════════════
   *  9. KHỞI ĐỘNG
   * ══════════════════════════════════════════════════════════════════ */

  function boot() {
    if (!/\/forms\//.test(location.pathname)) return;
    if (!document.querySelector('form, [role="listitem"], [jsname="M2UYVd"], [jsname="OCpkoe"]')) return;
    if (document.getElementById('hskaf')) return;

    buildUI();

    // Phím tắt: Alt+H mở/đóng bảng, Alt+F điền nhanh trang hiện tại.
    document.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      if (e.key === 'h' || e.key === 'H') {
        setOpen(!isOpen());
      } else if (e.key === 'f' || e.key === 'F') {
        setOpen(true);
        fillOnly();
      }
    });

    if (isRunning()) {
      trace('trang mới đã mở, chế độ tự động còn bật');
      setOpen(true);
      setTimeout(autoTick, 600);
      return;
    }

    // Lần dừng trước xảy ra đúng lúc trang đang chuyển ⇒ thông báo đã chết theo
    // trang cũ. Hiện lại ở đây để luôn biết vì sao nó ngừng.
    const why = recall(WHY_KEY);
    if (why) {
      keep(WHY_KEY, null);
      setOpen(true);
      log(why, 'warn');
      return;
    }

    // Không có cờ chạy, cũng không có lý do dừng: nếu lượt chạy vừa nãy còn dở
    // thì chính chỗ này là bằng chứng cờ chạy đã bị mất khi chuyển trang.
    let da = [];
    try { da = JSON.parse(recall(TRACE_KEY) || '[]'); } catch (e) { da = []; }
    if (da.length && !da[da.length - 1].includes('DỪNG')) {
      trace('trang mới đã mở nhưng CỜ CHẠY ĐÃ MẤT');
      setOpen(true);
      log('⚠ Chế độ tự động bị mất trạng thái khi chuyển trang.\n' +
          'Bấm "📋 Nhật ký" để xem chi tiết, hoặc bấm "▶ Chạy tự động" để chạy tiếp từ trang này.',
          'warn');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
