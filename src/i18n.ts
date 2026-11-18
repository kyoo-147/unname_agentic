import { SUPPORTED_TARGETS } from './core/language';

export type Locale = 'vi' | 'en' | 'zh';

export const LOCALES: readonly Locale[] = ['vi', 'en', 'zh'];
export const DEFAULT_LOCALE: Locale = 'vi';
export const LOCALE_STORAGE_KEY = 'mirror.locale';

const en = {
  appTitle: 'Mirror — a little closer to understanding',
  skipToContent: 'Skip to main content',
  libraryAria: 'Mirror library',
  openPdf: 'Open PDF',
  workspaceLabel: 'YOUR WORKSPACE',
  myLibrary: 'My library',
  sidebarNoteLead: 'A different language.',
  sidebarNoteTail: 'The same perspective.',
  settingsNav: 'Translation settings',
  privacyLead: 'Documents stay in this session.',
  privacyTail: 'Cloud translation is opt-in.',
  workspace: 'Workspace',
  localFirst: 'Local-first reading',
  libraryEyebrow: 'A LITTLE CLOSER TO UNDERSTANDING',
  libraryTitle: 'Your reading room.',
  libraryLead: 'Keep the original. Find the meaning beside it.',
  importDocument: 'Import document',
  allDocuments: 'All documents',
  recentlyOpened: 'Recently opened',
  dropTitle: 'Your next good read belongs here',
  dropHint: 'Drop a PDF, or browse your files',
  dropMeta: 'PDF documents · read locally · no account needed',
  stepOpen: '01 — OPEN',
  stepRead: '02 — READ SIDE BY SIDE',
  stepUnderstand: '03 — UNDERSTAND MORE',
  targetLanguageLabel: 'To',
  targetLanguageAria: 'Target language',
  zoomOut: 'Zoom out',
  zoomIn: 'Zoom in',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  pageInputAria: 'Page number',
  fitWidth: 'Fit width',
  fitPage: 'Fit page',
  rotatePage: 'Rotate page',
  outlineToggle: 'Outline',
  searchToggle: 'Search',
  thumbnailsToggle: 'Thumbnails',
  readerPanelAria: 'Document navigation panel',
  closePanel: 'Close panel',
  outlineLoading: 'Loading the outline…',
  outlineEmpty: 'This document has no outline.',
  searchPlaceholder: 'Search this document',
  searchHint: 'Case and accents are ignored.',
  searchEmpty: 'No matches found.',
  searchLoading: 'Searching…',
  searchResults: '{count} results',
  searchResultPage: 'Page {page}',
  pause: 'Pause',
  resume: 'Resume',
  translateAll: 'Translate all',
  stopFull: 'Stop full translation',
  retry: 'Retry',
  openOriginal: 'Open original ↗',
  originalHeading: 'ORIGINAL',
  originalNote: 'Unchanged source',
  translatedHeading: 'TRANSLATED MIRROR',
  providerInitial: 'Local · Vietnamese',
  linkedPages: 'Linked pages',
  selectRegionHint: 'Select any text region to compare',
  resizePanes: 'Resize original and translated panes',
  resetSplit: 'Reset split',
  pageInitial: 'Page 1',
  ready: 'Ready when you are.',
  languageSwitcher: 'Language',
  settingsEyebrow: 'MAKE IT YOURS',
  translationSettings: 'Translation settings',
  closeSettings: 'Close settings',
  settingsDescription: 'Only extracted text is sent to your chosen provider. Your PDF stays here. Credentials are kept in memory, not saved.',
  providerLabel: 'Provider',
  providerLocal: 'Local / Ollama (OpenAI-compatible)',
  providerGoogle: 'Google Cloud Translation',
  providerDeepl: 'DeepL',
  providerOpenai: 'OpenAI-compatible API',
  apiEndpoint: 'API endpoint',
  model: 'Model',
  targetLanguage: 'Target language',
  sourceLanguage: 'Source language',
  sourceAuto: 'Detect automatically',
  glossaryLabel: 'Glossary',
  glossaryPlaceholder: 'embedding = vector representation\ntoken = token',
  glossaryHelp: 'One term per line as "source = translation". Up to 200 terms.',
  glossaryProviderHint: 'Google and DeepL do not accept a custom glossary; these terms apply to OpenAI-compatible and local providers.',
  glossaryAccepted: '{count} terms accepted.',
  glossaryAcceptedIssue: '{count} terms accepted. Line {line}: {message}',
  glossaryIssueMissingSeparator: 'use "source = translation" on this line.',
  glossaryIssueEmptySource: 'the source term is empty.',
  glossaryIssueEmptyTarget: 'the translation is empty.',
  glossaryIssueSourceTooLong: 'the source term is longer than 64 characters.',
  glossaryIssueTargetTooLong: 'the translation is longer than 128 characters.',
  glossaryIssueDuplicate: 'this source term was already defined.',
  glossaryIssueEntryLimit: 'only the first 200 terms are kept.',
  detectedLanguageHint: 'Looks like this document is in {language}.',
  apiKey: 'API key',
  apiKeyPlaceholder: 'Not needed for a local server',
  cloudConsent: 'I allow extracted document text to be sent to the selected cloud provider. Provider charges may apply.',
  settingsHelp: 'Local endpoints must use localhost. If the provider is unavailable, the original stays readable; no substitute translation is invented.',
  applySettings: 'Apply & translate visible pages',
  pairedReading: 'Paired reading view',
  closePaired: 'Close paired view',
  original: 'Original',
  translation: 'Translation',
  translateRegion: 'Translate this region',
  pairedHelp: 'Region-level correspondence. Word alignment is not inferred.',
  pageStatus: 'Page {page} of {total}',
  pageLoading: '{page} · Loading page',
  translationFollows: 'Translation follows the original',
  scrollToRender: 'Scroll here to render',
  pagesOpened: '{pages} pages · Opened this session',
  compareRegion: 'Compare region: {text}',
  calloutTitle: 'Translation is complete. Open paired reading view to read without clipping.',
  calloutAria: 'Read complete translation in paired reading view',
  translationPending: 'Translation pending. Select "Translate this region" to prioritize it.',
  statusOpening: 'Opening PDF and extracting page geometry…',
  statusOriginalCloud: 'Original ready. Enable cloud consent in Translation settings to begin.',
  statusOriginalTranslating: 'Original ready. Translating visible pages first…',
  statusOpenError: 'Cannot open this document: {message} Choose a local PDF to try again.',
  statusPageError: 'Page {page}: {message}',
  statusTranslated: '{count} regions translated · {chars} characters sent · {mode} · {provider}',
  statusRotated: 'Page rotated to {degrees}°.',
  modePaused: 'Paused',
  modeFull: 'Full document',
  modeVisible: 'Visible pages first',
  statusPaused: 'Paused. In-flight requests may finish; no new translations will start.',
  statusResumed: 'Translation resumed.',
  statusRetrying: 'Retrying visible regions…',
  statusSettingsApplied: 'Settings applied. Translating visible pages…',
  statusGlossaryApplied: 'Glossary saved with {count} terms. Translating visible pages…',
  statusCloudNeeded: 'Cloud translation needs your explicit consent in settings.',
  statusCloudFirst: 'Enable cloud consent in Translation settings first.',
  statusAcquiring: 'Acquiring PDF from the source tab…',
  statusSourceError: 'Source disconnected or unavailable: {message} Use Open PDF to import a saved copy.',
  providerLocalShort: 'Local',
  popupModeOn: 'Automatic mirroring is on.',
  popupModeOff: 'Automatic mirroring is off.',
  popupIntro: 'Enable once to detect PDF URLs, PDF response types, and embedded PDFs in your browsing tabs. The original stays open. Mirrors open beside it without taking focus.',
  popupPrivacy: 'Detection runs locally. Translation sends text only to the provider you configure in the reader. Cloud providers require separate consent. No document text is sent just by detecting a PDF.',
  popupDesktopNote: 'Desktop transfer is optional and local only. Open the active PDF source or its mirror, then choose Open in desktop. No screenshots, provider settings, or API keys are sent.',
  popupEnable: 'Enable automatic mirrors',
  popupDisable: 'Disable automatic mirrors',
  popupOpenReader: 'Open reader and provider settings',
  popupDesktop: 'Open in desktop',
  popupDesktopStop: 'Stop desktop following',
  popupDesktopChecking: 'Checking desktop companion…',
  popupCaptureNote: 'Canvas or inaccessible viewer? Capture only the currently visible area. This is a screenshot, not a full document or a way around access restrictions. OCR requires a configured OCR service in the reader.',
  popupCapture: 'Capture this visible tab',
  desktopUnavailableFallback: 'Desktop companion status unavailable. The browser reader still works.',
  desktopSending: 'Sending the authorized PDF to your local desktop inbox…',
  desktopFailed: 'Desktop transfer failed.',
  desktopStoppedFail: 'Could not stop desktop following.',
  desktopUnavailable: 'Desktop companion unavailable. The browser reader still works.',
  desktopFollowing: 'Desktop companion is following the selected PDF locally.',
  desktopReady: 'Desktop companion ready. Open in desktop sends this PDF locally, with no provider upload.',
  desktopNoSource: 'No active PDF source.',
  desktopDelivered: 'PDF delivered to the local desktop inbox. Following page changes until you stop, close, or navigate the source. Open PDF Workspace to view it.',
  desktopStopped: 'Desktop following stopped. Already imported local PDF copies are retained.',
  selectTabFirst: 'Select a normal web document tab first.',
  captureFailed: 'Capture failed.',
} as const;

export type TranslationKey = keyof typeof en;

type Dictionary = Record<TranslationKey, string>;
type TranslationVars = Record<string, string | number>;

const vi: Dictionary = {
  appTitle: 'Mirror — hiểu thêm một chút',
  skipToContent: 'Chuyển đến nội dung chính',
  libraryAria: 'Thư viện Mirror',
  openPdf: 'Mở PDF',
  workspaceLabel: 'GÓC ĐỌC CỦA BẠN',
  myLibrary: 'Thư viện của tôi',
  sidebarNoteLead: 'Một ngôn ngữ khác.',
  sidebarNoteTail: 'Vẫn là góc nhìn ấy.',
  settingsNav: 'Cài đặt dịch',
  privacyLead: 'Tài liệu chỉ ở trong phiên này.',
  privacyTail: 'Dịch qua đám mây khi bạn cho phép.',
  workspace: 'Không gian',
  localFirst: 'Đọc ngay trên máy',
  libraryEyebrow: 'HIỂU THÊM MỘT CHÚT',
  libraryTitle: 'Phòng đọc của bạn.',
  libraryLead: 'Giữ bản gốc. Tìm nghĩa ngay bên cạnh.',
  importDocument: 'Thêm tài liệu',
  allDocuments: 'Tất cả tài liệu',
  recentlyOpened: 'Mở gần đây',
  dropTitle: 'Đặt tài liệu tiếp theo của bạn ở đây',
  dropHint: 'Kéo thả PDF hoặc chọn tệp trong máy',
  dropMeta: 'Tài liệu PDF · đọc trên máy · không cần tài khoản',
  stepOpen: '01 — MỞ',
  stepRead: '02 — ĐỌC SONG SONG',
  stepUnderstand: '03 — HIỂU SÂU HƠN',
  targetLanguageLabel: 'Sang',
  targetLanguageAria: 'Chọn ngôn ngữ đích',
  zoomOut: 'Thu nhỏ',
  zoomIn: 'Phóng to',
  previousPage: 'Trang trước',
  nextPage: 'Trang sau',
  pageInputAria: 'Số trang',
  fitWidth: 'Vừa chiều rộng',
  fitPage: 'Vừa trang',
  rotatePage: 'Xoay trang',
  outlineToggle: 'Mục lục',
  searchToggle: 'Tìm kiếm',
  thumbnailsToggle: 'Hình thu nhỏ',
  readerPanelAria: 'Bảng điều hướng tài liệu',
  closePanel: 'Đóng bảng',
  outlineLoading: 'Đang tải mục lục…',
  outlineEmpty: 'Tài liệu này không có mục lục.',
  searchPlaceholder: 'Tìm trong tài liệu',
  searchHint: 'Không phân biệt hoa thường và dấu.',
  searchEmpty: 'Không tìm thấy kết quả.',
  searchLoading: 'Đang tìm…',
  searchResults: '{count} kết quả',
  searchResultPage: 'Trang {page}',
  pause: 'Tạm dừng',
  resume: 'Tiếp tục',
  translateAll: 'Dịch toàn bộ',
  stopFull: 'Dừng dịch toàn bộ',
  retry: 'Thử lại',
  openOriginal: 'Mở bản gốc ↗',
  originalHeading: 'BẢN GỐC',
  originalNote: 'Nguyên văn',
  translatedHeading: 'BẢN DỊCH',
  providerInitial: 'Cục bộ · Tiếng Việt',
  linkedPages: 'Trang liên kết',
  selectRegionHint: 'Chọn một vùng chữ để đối chiếu',
  resizePanes: 'Kéo để đổi tỉ lệ hai cột gốc và dịch',
  resetSplit: 'Đặt lại tỉ lệ',
  pageInitial: 'Trang 1',
  ready: 'Sẵn sàng khi bạn muốn.',
  languageSwitcher: 'Ngôn ngữ',
  settingsEyebrow: 'CHỈNH THEO Ý BẠN',
  translationSettings: 'Cài đặt dịch',
  closeSettings: 'Đóng cài đặt',
  settingsDescription: 'Chỉ phần chữ được trích xuất mới gửi tới nhà cung cấp bạn chọn. PDF vẫn ở lại đây. Thông tin xác thực chỉ nằm trong bộ nhớ, không được lưu.',
  providerLabel: 'Nhà cung cấp',
  providerLocal: 'Cục bộ / Ollama (tương thích OpenAI)',
  providerGoogle: 'Google Cloud Translation',
  providerDeepl: 'DeepL',
  providerOpenai: 'API tương thích OpenAI',
  apiEndpoint: 'Địa chỉ API',
  model: 'Mô hình',
  targetLanguage: 'Ngôn ngữ đích',
  sourceLanguage: 'Ngôn ngữ nguồn',
  sourceAuto: 'Tự nhận diện',
  glossaryLabel: 'Thuật ngữ',
  glossaryPlaceholder: 'transformer = bộ biến đổi\nattention = cơ chế chú ý',
  glossaryHelp: 'Mỗi dòng một thuật ngữ, dạng "gốc = bản dịch". Tối đa 200 thuật ngữ.',
  glossaryProviderHint: 'Google và DeepL chưa nhận danh sách thuật ngữ riêng; mục này chỉ áp dụng cho OpenAI và máy chủ cục bộ.',
  glossaryAccepted: 'Đã nhận {count} thuật ngữ.',
  glossaryAcceptedIssue: 'Đã nhận {count} thuật ngữ. Dòng {line}: {message}',
  glossaryIssueMissingSeparator: 'cần viết dạng "gốc = bản dịch".',
  glossaryIssueEmptySource: 'thiếu thuật ngữ gốc.',
  glossaryIssueEmptyTarget: 'thiếu bản dịch.',
  glossaryIssueSourceTooLong: 'thuật ngữ gốc dài quá 64 ký tự.',
  glossaryIssueTargetTooLong: 'bản dịch dài quá 128 ký tự.',
  glossaryIssueDuplicate: 'thuật ngữ gốc này đã có ở dòng trước.',
  glossaryIssueEntryLimit: 'chỉ giữ 200 thuật ngữ đầu tiên.',
  detectedLanguageHint: 'Có vẻ tài liệu này viết bằng {language}.',
  apiKey: 'Khóa API',
  apiKeyPlaceholder: 'Không cần cho máy chủ cục bộ',
  cloudConsent: 'Tôi cho phép gửi phần chữ trích xuất từ tài liệu tới nhà cung cấp đám mây đã chọn. Có thể phát sinh phí từ nhà cung cấp.',
  settingsHelp: 'Máy chủ cục bộ phải dùng localhost. Nếu nhà cung cấp không sẵn sàng, bản gốc vẫn đọc được; ứng dụng không tự tạo bản dịch thay thế.',
  applySettings: 'Áp dụng và dịch các trang đang xem',
  pairedReading: 'Đọc song song theo vùng',
  closePaired: 'Đóng chế độ đọc song song',
  original: 'Bản gốc',
  translation: 'Bản dịch',
  translateRegion: 'Dịch vùng này',
  pairedHelp: 'Chỉ đối chiếu theo từng vùng, không căn chỉnh từng từ.',
  pageStatus: 'Trang {page} / {total}',
  pageLoading: '{page} · Đang tải trang',
  translationFollows: 'Bản dịch theo sau bản gốc',
  scrollToRender: 'Cuộn tới đây để tải trang',
  pagesOpened: '{pages} trang · Mở trong phiên này',
  compareRegion: 'Đối chiếu vùng: {text}',
  calloutTitle: 'Bản dịch đã đầy đủ. Mở chế độ đọc song song để đọc trọn vẹn.',
  calloutAria: 'Đọc bản dịch đầy đủ trong chế độ đọc song song',
  translationPending: 'Bản dịch đang chờ. Chọn "Dịch vùng này" để ưu tiên.',
  statusOpening: 'Đang mở PDF và đọc bố cục trang…',
  statusOriginalCloud: 'Bản gốc đã sẵn sàng. Bật đồng ý đám mây trong Cài đặt dịch để bắt đầu.',
  statusOriginalTranslating: 'Bản gốc đã sẵn sàng. Đang dịch các trang đang xem trước…',
  statusOpenError: 'Không mở được tài liệu: {message} Hãy chọn một PDF cục bộ khác.',
  statusPageError: 'Trang {page}: {message}',
  statusTranslated: '{count} vùng đã dịch · {chars} ký tự đã gửi · {mode} · {provider}',
  statusRotated: 'Đã xoay trang {degrees}°.',
  modePaused: 'Tạm dừng',
  modeFull: 'Toàn bộ tài liệu',
  modeVisible: 'Ưu tiên trang đang xem',
  statusPaused: 'Đã tạm dừng. Các yêu cầu đang chạy có thể hoàn tất; không có bản dịch mới nào bắt đầu.',
  statusResumed: 'Đã tiếp tục dịch.',
  statusRetrying: 'Đang thử lại các vùng đang xem…',
  statusSettingsApplied: 'Đã áp dụng cài đặt. Đang dịch các trang đang xem…',
  statusGlossaryApplied: 'Đã lưu {count} thuật ngữ. Đang dịch các trang đang xem…',
  statusCloudNeeded: 'Dịch qua đám mây cần bạn đồng ý rõ ràng trong cài đặt.',
  statusCloudFirst: 'Hãy bật đồng ý đám mây trong Cài đặt dịch trước.',
  statusAcquiring: 'Đang lấy PDF từ tab nguồn…',
  statusSourceError: 'Nguồn đã ngắt hoặc không khả dụng: {message} Dùng Mở PDF để nhập bản đã lưu.',
  providerLocalShort: 'Cục bộ',
  popupModeOn: 'Tự động mở bản dịch đang bật.',
  popupModeOff: 'Tự động mở bản dịch đang tắt.',
  popupIntro: 'Bật một lần để nhận diện URL PDF, phản hồi PDF và PDF nhúng trong các tab bạn đang xem. Bản gốc vẫn mở. Bản dịch mở bên cạnh và không cướp tiêu điểm.',
  popupPrivacy: 'Việc nhận diện chạy trên máy. Bản dịch chỉ gửi phần chữ tới nhà cung cấp bạn cấu hình trong trình đọc. Nhà cung cấp đám mây cần bạn đồng ý riêng. Chỉ nhận diện PDF thì không gửi chữ nào.',
  popupDesktopNote: 'Chuyển sang ứng dụng desktop là tuỳ chọn và chỉ chạy cục bộ. Mở PDF nguồn hoặc bản dịch đang xem, rồi chọn Mở trên desktop. Không gửi ảnh chụp, cài đặt nhà cung cấp hay khóa API.',
  popupEnable: 'Bật tự động mở bản dịch',
  popupDisable: 'Tắt tự động mở bản dịch',
  popupOpenReader: 'Mở trình đọc và cài đặt nhà cung cấp',
  popupDesktop: 'Mở trên desktop',
  popupDesktopStop: 'Dừng theo dõi desktop',
  popupDesktopChecking: 'Đang kiểm tra ứng dụng desktop…',
  popupCaptureNote: 'Trình xem dùng canvas hoặc không truy cập được? Chỉ chụp vùng đang hiện. Đây là ảnh chụp, không phải toàn bộ tài liệu và không phải cách vượt giới hạn truy cập. OCR cần dịch vụ OCR đã cấu hình trong trình đọc.',
  popupCapture: 'Chụp tab đang xem',
  desktopUnavailableFallback: 'Không lấy được trạng thái ứng dụng desktop. Trình đọc trên trình duyệt vẫn dùng được.',
  desktopSending: 'Đang gửi PDF đã được cho phép tới hộp thư desktop trên máy…',
  desktopFailed: 'Gửi sang desktop thất bại.',
  desktopStoppedFail: 'Không dừng được việc theo dõi desktop.',
  desktopUnavailable: 'Ứng dụng desktop không sẵn sàng. Trình đọc trên trình duyệt vẫn dùng được.',
  desktopFollowing: 'Ứng dụng desktop đang theo dõi PDF đã chọn ngay trên máy.',
  desktopReady: 'Ứng dụng desktop đã sẵn sàng. Mở trên desktop gửi PDF ngay trên máy, không tải lên nhà cung cấp.',
  desktopNoSource: 'Chưa có PDF nguồn đang mở.',
  desktopDelivered: 'PDF đã vào hộp thư desktop trên máy. Ứng dụng theo trang cho tới khi bạn dừng, đóng hoặc chuyển trang nguồn. Mở PDF Workspace để xem.',
  desktopStopped: 'Đã dừng theo dõi desktop. Các bản PDF cục bộ đã nhập vẫn được giữ.',
  selectTabFirst: 'Hãy chọn một tab tài liệu web thông thường trước.',
  captureFailed: 'Chụp màn hình thất bại.',
};

const zh: Dictionary = {
  appTitle: 'Mirror — 更靠近一点理解',
  skipToContent: '跳至主要内容',
  libraryAria: 'Mirror 书库',
  openPdf: '打开 PDF',
  workspaceLabel: '你的阅读空间',
  myLibrary: '我的书库',
  sidebarNoteLead: '另一种语言。',
  sidebarNoteTail: '同一种视角。',
  settingsNav: '翻译设置',
  privacyLead: '文档只留在本次会话中。',
  privacyTail: '云端翻译需你主动开启。',
  workspace: '工作区',
  localFirst: '本地优先阅读',
  libraryEyebrow: '再靠近一点理解',
  libraryTitle: '你的阅读室。',
  libraryLead: '留住原文，在旁找到意思。',
  importDocument: '导入文档',
  allDocuments: '全部文档',
  recentlyOpened: '最近打开',
  dropTitle: '下一篇好读物从这里开始',
  dropHint: '拖入 PDF，或浏览本地文件',
  dropMeta: 'PDF 文档 · 本地阅读 · 无需账号',
  stepOpen: '01 — 打开',
  stepRead: '02 — 并排阅读',
  stepUnderstand: '03 — 理解更多',
  targetLanguageLabel: '译为',
  targetLanguageAria: '目标语言',
  zoomOut: '缩小',
  zoomIn: '放大',
  previousPage: '上一页',
  nextPage: '下一页',
  pageInputAria: '页码',
  fitWidth: '适合宽度',
  fitPage: '适合整页',
  rotatePage: '旋转页面',
  outlineToggle: '目录',
  searchToggle: '搜索',
  thumbnailsToggle: '缩略图',
  readerPanelAria: '文档导航面板',
  closePanel: '关闭面板',
  outlineLoading: '正在加载目录…',
  outlineEmpty: '此文档没有目录。',
  searchPlaceholder: '在文档中搜索',
  searchHint: '不区分大小写和声调。',
  searchEmpty: '没有找到结果。',
  searchLoading: '正在搜索…',
  searchResults: '{count} 个结果',
  searchResultPage: '第 {page} 页',
  pause: '暂停',
  resume: '继续',
  translateAll: '翻译全文',
  stopFull: '停止翻译全文',
  retry: '重试',
  openOriginal: '打开原文 ↗',
  originalHeading: '原文',
  originalNote: '未改动',
  translatedHeading: '译文镜像',
  providerInitial: '本地 · 越南语',
  linkedPages: '联动页码',
  selectRegionHint: '选中任意文字区域即可对照',
  resizePanes: '调整原文与译文分栏宽度',
  resetSplit: '重置分栏',
  pageInitial: '第 1 页',
  ready: '准备就绪。',
  languageSwitcher: '语言',
  settingsEyebrow: '按你的习惯来',
  translationSettings: '翻译设置',
  closeSettings: '关闭设置',
  settingsDescription: '只有提取出的文字会发送给你选择的提供商。PDF 留在这里。凭据只保存在内存中，不会写入磁盘。',
  providerLabel: '提供商',
  providerLocal: '本地 / Ollama（兼容 OpenAI）',
  providerGoogle: 'Google Cloud Translation',
  providerDeepl: 'DeepL',
  providerOpenai: '兼容 OpenAI 的 API',
  apiEndpoint: 'API 地址',
  model: '模型',
  targetLanguage: '目标语言',
  sourceLanguage: '源语言',
  sourceAuto: '自动识别',
  glossaryLabel: '术语表',
  glossaryPlaceholder: 'transformer = 变换器\nattention = 注意力机制',
  glossaryHelp: '每行一个术语，格式为“原文 = 译文”。最多 200 条。',
  glossaryProviderHint: 'Google 和 DeepL 不接受自定义术语表；这些术语仅适用于兼容 OpenAI 的接口和本地服务。',
  glossaryAccepted: '已接受 {count} 条术语。',
  glossaryAcceptedIssue: '已接受 {count} 条术语。第 {line} 行：{message}',
  glossaryIssueMissingSeparator: '请写成“原文 = 译文”。',
  glossaryIssueEmptySource: '缺少原文术语。',
  glossaryIssueEmptyTarget: '缺少译文。',
  glossaryIssueSourceTooLong: '原文术语超过 64 个字符。',
  glossaryIssueTargetTooLong: '译文超过 128 个字符。',
  glossaryIssueDuplicate: '该原文术语已在前面定义。',
  glossaryIssueEntryLimit: '只保留前 200 条术语。',
  detectedLanguageHint: '这份文档似乎是 {language}。',
  apiKey: 'API 密钥',
  apiKeyPlaceholder: '本地服务器不需要',
  cloudConsent: '我允许将文档中提取的文字发送给所选的云端提供商。可能产生提供商费用。',
  settingsHelp: '本地服务必须使用 localhost。提供商不可用时，原文仍可阅读；不会伪造替代译文。',
  applySettings: '应用并翻译当前可见页',
  pairedReading: '并排阅读',
  closePaired: '关闭并排阅读',
  original: '原文',
  translation: '译文',
  translateRegion: '翻译此区域',
  pairedHelp: '只按区域对照，不做逐词对齐。',
  pageStatus: '第 {page} 页 / 共 {total} 页',
  pageLoading: '{page} · 正在加载页面',
  translationFollows: '译文跟随原文',
  scrollToRender: '滚动到此处以加载页面',
  pagesOpened: '{pages} 页 · 本次会话中打开',
  compareRegion: '对照区域：{text}',
  calloutTitle: '译文已完整。打开并排阅读即可完整查看。',
  calloutAria: '在并排阅读中查看完整译文',
  translationPending: '译文待处理。选择“翻译此区域”以优先处理。',
  statusOpening: '正在打开 PDF 并提取页面几何信息…',
  statusOriginalCloud: '原文已就绪。在翻译设置中开启云端同意后即可开始。',
  statusOriginalTranslating: '原文已就绪。正在优先翻译当前可见页…',
  statusOpenError: '无法打开此文档：{message} 请选择一个本地 PDF 重试。',
  statusPageError: '第 {page} 页：{message}',
  statusTranslated: '已翻译 {count} 个区域 · 已发送 {chars} 个字符 · {mode} · {provider}',
  statusRotated: '页面已旋转 {degrees}°。',
  modePaused: '已暂停',
  modeFull: '全文',
  modeVisible: '优先可见页',
  statusPaused: '已暂停。进行中的请求可能完成；不会开始新的翻译。',
  statusResumed: '已继续翻译。',
  statusRetrying: '正在重试可见区域…',
  statusSettingsApplied: '设置已应用。正在翻译当前可见页…',
  statusGlossaryApplied: '已保存 {count} 条术语。正在翻译当前可见页…',
  statusCloudNeeded: '云端翻译需要你在设置中明确同意。',
  statusCloudFirst: '请先在翻译设置中开启云端同意。',
  statusAcquiring: '正在从来源标签页获取 PDF…',
  statusSourceError: '来源已断开或不可用：{message} 使用“打开 PDF”导入已保存的副本。',
  providerLocalShort: '本地',
  popupModeOn: '自动打开译文已开启。',
  popupModeOff: '自动打开译文已关闭。',
  popupIntro: '开启一次即可识别浏览标签页中的 PDF URL、PDF 响应和内嵌 PDF。原文保持打开。译文在旁打开，不抢焦点。',
  popupPrivacy: '识别在本地运行。翻译只把文字发送给你在阅读器中配置的提供商。云端提供商需要你另行同意。仅仅识别 PDF 不会发送任何文档文字。',
  popupDesktopNote: '桌面传输是可选项，且只在本地进行。打开当前 PDF 来源或其译文，然后选择在桌面打开。不会发送截图、提供商设置或 API 密钥。',
  popupEnable: '开启自动译文',
  popupDisable: '关闭自动译文',
  popupOpenReader: '打开阅读器和提供商设置',
  popupDesktop: '在桌面打开',
  popupDesktopStop: '停止桌面跟随',
  popupDesktopChecking: '正在检查桌面应用…',
  popupCaptureNote: '查看器使用 canvas 或无法访问？只截取当前可见区域。这是截图，不是完整文档，也不是绕过访问限制的办法。OCR 需要先在阅读器中配置 OCR 服务。',
  popupCapture: '截取当前标签页',
  desktopUnavailableFallback: '无法获取桌面应用状态。浏览器阅读器仍可使用。',
  desktopSending: '正在把已授权的 PDF 发送到本地桌面收件箱…',
  desktopFailed: '桌面传输失败。',
  desktopStoppedFail: '无法停止桌面跟随。',
  desktopUnavailable: '桌面应用不可用。浏览器阅读器仍可使用。',
  desktopFollowing: '桌面应用正在本地跟随所选 PDF。',
  desktopReady: '桌面应用已就绪。在桌面打开会把 PDF 发送到本地，不上传提供商。',
  desktopNoSource: '当前没有打开的 PDF 来源。',
  desktopDelivered: 'PDF 已进入本地桌面收件箱。桌面会跟随翻页，直到你停止、关闭或切换来源。打开 PDF Workspace 即可查看。',
  desktopStopped: '已停止桌面跟随。已导入的本地 PDF 副本仍会保留。',
  selectTabFirst: '请先选择一个普通网页标签页。',
  captureFailed: '截图失败。',
};

const dictionaries: Record<Locale, Dictionary> = { vi, en, zh };

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function dictionaryFor(locale: Locale): Readonly<Dictionary> {
  return dictionaries[locale];
}

export function isLocale(value: unknown): value is Locale {
  return value === 'vi' || value === 'en' || value === 'zh';
}

function browserStorage(): LocaleStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

let storage: LocaleStorage | undefined = browserStorage();
let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<(locale: Locale) => void>();

export function initLocale(candidate?: LocaleStorage): Locale {
  storage = candidate ?? browserStorage();
  let saved: string | null = null;
  try {
    saved = storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    saved = null;
  }
  current = isLocale(saved) ? saved : DEFAULT_LOCALE;
  return current;
}

export function getLocale(): Locale {
  return current;
}

export function localeLabel(locale: Locale): string {
  return locale.toUpperCase();
}

export function t(key: TranslationKey, vars?: TranslationVars): string {
  const template = dictionaries[current][key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(vars, name) ? String(vars[name]) : match);
}

export function setLocale(locale: Locale, target?: LocaleStorage): void {
  const next = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const sink = target ?? storage ?? browserStorage();
  try {
    sink?.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    storage = undefined;
  }
  current = next;
  apply();
  listeners.forEach(listener => listener(next));
}

export function subscribe(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function apply(root?: ParentNode): void {
  const scope = root ?? (typeof document === 'undefined' ? undefined : document);
  if (scope) {
    scope.querySelectorAll<HTMLElement>('[data-i18n]').forEach(element => {
      element.textContent = t(element.dataset.i18n as TranslationKey);
    });
    scope.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach(element => {
      element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder as TranslationKey));
    });
    scope.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(element => {
      element.title = t(element.dataset.i18nTitle as TranslationKey);
    });
    scope.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach(element => {
      element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel as TranslationKey));
    });
    scope.querySelectorAll<HTMLElement>('[data-locale]').forEach(element => {
      element.setAttribute('aria-pressed', String(element.dataset.locale === current));
    });
  }
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}

export function clampPageNumber(value: number, total: number): number {
  const last = Number.isFinite(total) ? Math.max(1, Math.trunc(total)) : 1;
  if (!Number.isFinite(value)) return 1;
  return Math.min(last, Math.max(1, Math.trunc(value)));
}

export function languageNativeName(code: string): string {
  const normalized = code.trim().toLowerCase();
  return SUPPORTED_TARGETS.find(target => target.code === normalized)?.nativeName ?? normalized.toUpperCase();
}

export function documentReadingKey(title: string, size: number, base = 'mirror.reading-state'): string {
  const name = title.trim().replace(/\s+/g, ' ');
  const bytes = Number.isFinite(size) ? Math.max(0, Math.trunc(size)) : 0;
  return `${base}:${name}:${bytes}`;
}
