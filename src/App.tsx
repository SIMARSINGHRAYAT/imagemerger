import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { jsPDF } from "jspdf";

type LayoutMode = "vertical" | "horizontal" | "grid" | "custom";
type FitMode = "original" | "fit" | "fill" | "stretch" | "match-width" | "match-height";
type ExportFormat = "png" | "jpeg" | "webp";
type BackgroundMode = "white" | "black" | "transparent" | "custom";
type GridMode = "auto" | "2" | "3" | "4" | "custom";

interface UploadedImage {
  id: string;
  file: File;
  url: string;
  name: string;
  type: string;
  size: number;
  originalWidth: number;
  originalHeight: number;
  currentWidth: number;
  currentHeight: number;
  x: number;
  y: number;
  rotation: number;
  scale: number;
}

interface ToastItem {
  id: string;
  message: string;
  kind: "error" | "success" | "info";
}

interface MergeSettings {
  layout: LayoutMode;
  fit: FitMode;
  gridMode: GridMode;
  customColumns: number;
  spacing: number;
  spacingColor: string;
  backgroundMode: BackgroundMode;
  customBackground: string;
  borderEnabled: boolean;
  borderThickness: number;
  borderRadius: number;
  borderColor: string;
  exportFormat: ExportFormat;
  quality: number;
  autoExpandCanvas: boolean;
  canvasWidth: number;
  canvasHeight: number;
  filename: string;
}

interface MergeResult {
  url: string;
  blob: Blob;
  width: number;
  height: number;
  format: ExportFormat;
  imageCount: number;
  totalPixels: number;
}

interface PdfPagePreview {
  id: string;
  name: string;
  url: string;
  blob: Blob;
  width: number;
  height: number;
}

interface SaveFilePickerHandle {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<SaveFilePickerHandle>;
};

interface PreviewState {
  imageId: string;
  zoom: number;
  fit: boolean;
}

interface ResizeState {
  imageId: string;
  width: number;
  height: number;
  lockAspect: boolean;
}

interface ResultViewerState {
  zoom: number;
  fit: boolean;
  fullscreen: boolean;
}

interface HistorySnapshot {
  images: UploadedImage[];
  canvasWidth: number;
  canvasHeight: number;
  autoExpandCanvas: boolean;
}

const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const SUPPORTED_EXT = /\.(jpg|jpeg|png|webp)$/i;
const MAX_CANVAS_EDGE = 32767;
const MAX_CANVAS_PIXELS = 268_000_000;
const MAX_HISTORY = 80;

const DEFAULT_SETTINGS: MergeSettings = {
  layout: "vertical",
  fit: "fit",
  gridMode: "auto",
  customColumns: 3,
  spacing: 0,
  spacingColor: "#101010",
  backgroundMode: "white",
  customBackground: "#0a0a0a",
  borderEnabled: false,
  borderThickness: 4,
  borderRadius: 8,
  borderColor: "#22d3ee",
  exportFormat: "png",
  quality: 100,
  autoExpandCanvas: true,
  canvasWidth: 1920,
  canvasHeight: 1080,
  filename: "merged-image",
};

function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** idx).toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function mimeForFormat(format: ExportFormat) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function extForFormat(format: ExportFormat) {
  if (format === "jpeg") return "jpg";
  return format;
}

function normalizeRotation(value: number) {
  const next = value % 360;
  return next < 0 ? next + 360 : next;
}

function cloneImages(images: UploadedImage[]) {
  return images.map((img) => ({ ...img }));
}

function moveItem<T>(items: T[], from: number, to: number) {
  const next = [...items];
  const [picked] = next.splice(from, 1);
  next.splice(to, 0, picked);
  return next;
}

function drawRoundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const ratio = Math.min(w / bitmap.width, h / bitmap.height);
  const dw = bitmap.width * ratio;
  const dh = bitmap.height * ratio;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.drawImage(bitmap, dx, dy, dw, dh);
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const ratio = Math.max(w / bitmap.width, h / bitmap.height);
  const sw = w / ratio;
  const sh = h / ratio;
  const sx = (bitmap.width - sw) / 2;
  const sy = (bitmap.height - sh) / 2;
  ctx.drawImage(bitmap, sx, sy, sw, sh, x, y, w, h);
}

async function readImageDimensions(file: File) {
  const bitmap = await createImageBitmap(file);
  const dims = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dims;
}

function getImageAspectText(width: number, height: number) {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const div = gcd(width, height);
  return `${Math.round(width / div)}:${Math.round(height / div)}`;
}

function getQualityStatus(image: UploadedImage) {
  if (image.currentWidth === image.originalWidth && image.currentHeight === image.originalHeight) {
    return "Original Quality";
  }
  if (image.currentWidth > image.originalWidth || image.currentHeight > image.originalHeight) {
    return "Upscaled";
  }
  return "Resized";
}

function getRotatedBounds(x: number, y: number, width: number, height: number, rotationDeg: number) {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const boxW = Math.abs(width * cos) + Math.abs(height * sin);
  const boxH = Math.abs(width * sin) + Math.abs(height * cos);
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  return {
    left: centerX - boxW / 2,
    right: centerX + boxW / 2,
    top: centerY - boxH / 2,
    bottom: centerY + boxH / 2,
    width: boxW,
    height: boxH,
  };
}

function isSupportedFile(file: File) {
  if (SUPPORTED_MIME.has(file.type.toLowerCase())) return true;
  return SUPPORTED_EXT.test(file.name);
}

function sanitizeFileName(name: string, fallback: string) {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .trim()
    .replace(/[. ]+$/g, "") || fallback;
}

export default function App() {
  const [started, setStarted] = useState(false);
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [settings, setSettings] = useState<MergeSettings>(DEFAULT_SETTINGS);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [pdfPages, setPdfPages] = useState<PdfPagePreview[]>([]);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [isCreatingPdf, setIsCreatingPdf] = useState(false);
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [isDraggingUpload, setIsDraggingUpload] = useState(false);
  const [resultViewer, setResultViewer] = useState<ResultViewerState>({
    zoom: 1,
    fit: true,
    fullscreen: false,
  });
  const [historyPast, setHistoryPast] = useState<HistorySnapshot[]>([]);
  const [historyFuture, setHistoryFuture] = useState<HistorySnapshot[]>([]);

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const replaceDragCache = useRef<string | null>(null);
  const previewWrapRef = useRef<HTMLDivElement | null>(null);
  const resultWrapRef = useRef<HTMLDivElement | null>(null);
  const imagesRef = useRef<UploadedImage[]>([]);
  const settingsRef = useRef<MergeSettings>(DEFAULT_SETTINGS);
  const resultRef = useRef<MergeResult | null>(null);
  const pdfPagesRef = useRef<PdfPagePreview[]>([]);

  const canMerge = images.length >= 2 && !isMerging && !isCreatingPdf;
  const selectedLayer = useMemo(
    () => images.find((image) => image.id === selectedLayerId) ?? null,
    [images, selectedLayerId],
  );
  const previewImage = useMemo(
    () => images.find((image) => image.id === previewState?.imageId) ?? null,
    [images, previewState?.imageId],
  );

  const transparencyAvailable = settings.exportFormat !== "jpeg";
  const effectiveBackground =
    settings.backgroundMode === "custom"
      ? settings.customBackground
      : settings.backgroundMode === "black"
        ? "#050505"
        : settings.backgroundMode === "transparent"
          ? "transparent"
          : "#ffffff";

  const gridColumns = useMemo(() => {
    if (settings.gridMode === "custom") return Math.max(1, Math.min(12, settings.customColumns));
    if (settings.gridMode === "auto") return Math.max(1, Math.ceil(Math.sqrt(images.length || 1)));
    return Number(settings.gridMode);
  }, [images.length, settings.customColumns, settings.gridMode]);

  const customDisplayScale = useMemo(() => {
    if (settings.canvasWidth <= 0 || settings.canvasHeight <= 0) return 1;
    const maxW = 980;
    const maxH = 520;
    return Math.min(1, maxW / settings.canvasWidth, maxH / settings.canvasHeight);
  }, [settings.canvasHeight, settings.canvasWidth]);

  const addToast = (message: string, kind: ToastItem["kind"] = "info") => {
    const id = makeId();
    setToasts((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 3600);
  };

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    pdfPagesRef.current = pdfPages;
  }, [pdfPages]);

  useEffect(() => {
    return () => {
      imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url));
      if (resultRef.current?.url) URL.revokeObjectURL(resultRef.current.url);
      pdfPagesRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewState(null);
        setResizeState(null);
        setResultViewer((prev) => ({ ...prev, fullscreen: false }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const createSnapshot = (): HistorySnapshot => ({
    images: cloneImages(imagesRef.current),
    canvasWidth: settingsRef.current.canvasWidth,
    canvasHeight: settingsRef.current.canvasHeight,
    autoExpandCanvas: settingsRef.current.autoExpandCanvas,
  });

  const restoreSnapshot = (snapshot: HistorySnapshot) => {
    setImages(cloneImages(snapshot.images));
    setSettings((prev) => ({
      ...prev,
      canvasWidth: snapshot.canvasWidth,
      canvasHeight: snapshot.canvasHeight,
      autoExpandCanvas: snapshot.autoExpandCanvas,
    }));
  };

  const pushHistory = () => {
    setHistoryPast((prev) => {
      const next = [...prev, createSnapshot()];
      if (next.length > MAX_HISTORY) return next.slice(next.length - MAX_HISTORY);
      return next;
    });
    setHistoryFuture([]);
  };

  const undo = () => {
    setHistoryPast((past) => {
      if (past.length === 0) return past;
      const last = past[past.length - 1];
      const now = createSnapshot();
      setHistoryFuture((future) => [now, ...future]);
      restoreSnapshot(last);
      return past.slice(0, -1);
    });
  };

  const redo = () => {
    setHistoryFuture((future) => {
      if (future.length === 0) return future;
      const [next, ...rest] = future;
      const now = createSnapshot();
      setHistoryPast((past) => {
        const updated = [...past, now];
        return updated.length > MAX_HISTORY ? updated.slice(updated.length - MAX_HISTORY) : updated;
      });
      restoreSnapshot(next);
      return rest;
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isEditable =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }

      if (settingsRef.current.layout !== "custom" || !selectedLayerId || isEditable) return;

      const step = event.shiftKey ? 10 : 1;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        pushHistory();
        setImages((prev) =>
          prev.map((image) => {
            if (image.id !== selectedLayerId) return image;
            if (event.key === "ArrowLeft") return { ...image, x: image.x - step };
            if (event.key === "ArrowRight") return { ...image, x: image.x + step };
            if (event.key === "ArrowUp") return { ...image, y: image.y - step };
            return { ...image, y: image.y + step };
          }),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedLayerId]);

  const resetResult = () => {
    if (result?.url) URL.revokeObjectURL(result.url);
    pdfPages.forEach((item) => URL.revokeObjectURL(item.url));
    setResult(null);
    setPdfPages([]);
    setPdfBlob(null);
    setResultViewer({ zoom: 1, fit: true, fullscreen: false });
  };

  const openUploadPicker = () => uploadInputRef.current?.click();

  const processFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const accepted: UploadedImage[] = [];

    for (const file of files) {
      if (!isSupportedFile(file)) {
        addToast("Unsupported image format. Please upload JPG, JPEG, PNG, or WEBP files.", "error");
        continue;
      }

      try {
        const { width, height } = await readImageDimensions(file);
        accepted.push({
          id: makeId(),
          file,
          url: URL.createObjectURL(file),
          name: file.name,
          type: file.type || "image/unknown",
          size: file.size,
          originalWidth: width,
          originalHeight: height,
          currentWidth: width,
          currentHeight: height,
          x: 0,
          y: 0,
          rotation: 0,
          scale: 1,
        });
      } catch {
        addToast("This image could not be processed. Try another file.", "error");
      }
    }

    if (accepted.length > 0) {
      pushHistory();
      setImages((prev) => [...prev, ...accepted]);
      if (!selectedLayerId && accepted[0]) setSelectedLayerId(accepted[0].id);
      addToast(`${accepted.length} image${accepted.length > 1 ? "s" : ""} added.`, "success");
    }
  };

  const clearImages = (withConfirm = true) => {
    if (withConfirm && !window.confirm("Clear all uploaded images?")) return;
    images.forEach((image) => URL.revokeObjectURL(image.url));
    setImages([]);
    setSelectedLayerId(null);
    setPreviewState(null);
    setResizeState(null);
    setHistoryPast([]);
    setHistoryFuture([]);
    resetResult();
  };

  const removeImage = (id: string) => {
    pushHistory();
    setImages((prev) => {
      const target = prev.find((img) => img.id === id);
      if (target) URL.revokeObjectURL(target.url);
      const next = prev.filter((img) => img.id !== id);
      if (selectedLayerId === id) setSelectedLayerId(next[0]?.id ?? null);
      return next;
    });
    if (previewState?.imageId === id) setPreviewState(null);
  };

  const onDropUpload = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingUpload(false);
    void processFiles(event.dataTransfer.files);
  };

  const resetSettings = () => {
    setSettings((prev) => ({
      ...DEFAULT_SETTINGS,
      exportFormat: prev.exportFormat,
      quality: prev.quality,
      filename: prev.filename,
    }));
    addToast("Settings reset to defaults.", "info");
  };

  const startNewMerge = () => {
    if (!window.confirm("Start new merge and clear all work?")) return;
    clearImages(false);
    setSettings(DEFAULT_SETTINGS);
    addToast("Workspace reset.", "success");
  };

  const setExportFormat = (format: ExportFormat) => {
    setSettings((prev) => {
      const nextBackground = format === "jpeg" && prev.backgroundMode === "transparent" ? "white" : prev.backgroundMode;
      return {
        ...prev,
        exportFormat: format,
        backgroundMode: nextBackground,
        quality: prev.quality || 100,
      };
    });
  };

  const openResizeModal = (image: UploadedImage) => {
    setResizeState({
      imageId: image.id,
      width: image.currentWidth,
      height: image.currentHeight,
      lockAspect: true,
    });
  };

  const applyResizeModal = () => {
    if (!resizeState) return;
    const width = Math.max(1, Math.round(resizeState.width));
    const height = Math.max(1, Math.round(resizeState.height));
    pushHistory();
    setImages((prev) =>
      prev.map((image) => {
        if (image.id !== resizeState.imageId) return image;
        return { ...image, currentWidth: width, currentHeight: height };
      }),
    );
    setResizeState(null);
    addToast("Resize settings updated.", "success");
  };

  const setResizePreset = (preset: "25" | "50" | "75" | "100" | "150" | "200" | "original" | "custom") => {
    if (!resizeState) return;
    const image = images.find((img) => img.id === resizeState.imageId);
    if (!image) return;

    if (preset === "custom") return;
    if (preset === "original") {
      setResizeState((prev) => (prev ? { ...prev, width: image.originalWidth, height: image.originalHeight } : prev));
      return;
    }
    const factor = Number(preset) / 100;
    setResizeState((prev) =>
      prev
        ? {
            ...prev,
            width: Math.max(1, Math.round(image.originalWidth * factor)),
            height: Math.max(1, Math.round(image.originalHeight * factor)),
          }
        : prev,
    );
  };

  const updateResizeWidth = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (!resizeState || Number.isNaN(value)) return;
    const image = images.find((img) => img.id === resizeState.imageId);
    if (!image) return;
    setResizeState((prev) => {
      if (!prev) return prev;
      if (!prev.lockAspect) return { ...prev, width: value };
      const ratio = image.originalHeight / image.originalWidth;
      return { ...prev, width: value, height: Math.max(1, Math.round(value * ratio)) };
    });
  };

  const updateResizeHeight = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (!resizeState || Number.isNaN(value)) return;
    const image = images.find((img) => img.id === resizeState.imageId);
    if (!image) return;
    setResizeState((prev) => {
      if (!prev) return prev;
      if (!prev.lockAspect) return { ...prev, height: value };
      const ratio = image.originalWidth / image.originalHeight;
      return { ...prev, height: value, width: Math.max(1, Math.round(value * ratio)) };
    });
  };

  const resetSingleImage = (id: string) => {
    pushHistory();
    setImages((prev) =>
      prev.map((image) => {
        if (image.id !== id) return image;
        return {
          ...image,
          currentWidth: image.originalWidth,
          currentHeight: image.originalHeight,
          x: 0,
          y: 0,
          rotation: 0,
          scale: 1,
        };
      }),
    );
    addToast("Image reset to original state.", "info");
  };

  const setLayerOrder = (id: string, direction: "forward" | "backward" | "front" | "back") => {
    pushHistory();
    setImages((prev) => {
      const index = prev.findIndex((img) => img.id === id);
      if (index < 0) return prev;
      if (direction === "forward" && index < prev.length - 1) return moveItem(prev, index, index + 1);
      if (direction === "backward" && index > 0) return moveItem(prev, index, index - 1);
      if (direction === "front") return moveItem(prev, index, prev.length - 1);
      if (direction === "back") return moveItem(prev, index, 0);
      return prev;
    });
  };

  const alignSelectedLayer = (mode: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
    if (!selectedLayerId) return;
    pushHistory();
    setImages((prev) =>
      prev.map((image) => {
        if (image.id !== selectedLayerId) return image;
        const width = image.currentWidth * image.scale;
        const height = image.currentHeight * image.scale;
        if (mode === "left") return { ...image, x: 0 };
        if (mode === "center") return { ...image, x: (settings.canvasWidth - width) / 2 };
        if (mode === "right") return { ...image, x: settings.canvasWidth - width };
        if (mode === "top") return { ...image, y: 0 };
        if (mode === "middle") return { ...image, y: (settings.canvasHeight - height) / 2 };
        return { ...image, y: settings.canvasHeight - height };
      }),
    );
  };

  const rotateSelected = (delta: number) => {
    if (!selectedLayerId) return;
    pushHistory();
    setImages((prev) =>
      prev.map((image) => {
        if (image.id !== selectedLayerId) return image;
        return { ...image, rotation: normalizeRotation(image.rotation + delta) };
      }),
    );
  };

  const onDragLayerStart = (event: ReactMouseEvent<HTMLDivElement>, image: UploadedImage) => {
    if (settings.layout !== "custom") return;
    event.preventDefault();
    setSelectedLayerId(image.id);
    pushHistory();

    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startX = image.x;
    const startY = image.y;

    const onMove = (moveEvent: MouseEvent) => {
      const dx = (moveEvent.clientX - startClientX) / customDisplayScale;
      const dy = (moveEvent.clientY - startClientY) / customDisplayScale;
      setImages((prev) =>
        prev.map((img) => (img.id === image.id ? { ...img, x: Math.round(startX + dx), y: Math.round(startY + dy) } : img)),
      );
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onLayerResizeHandleStart = (event: ReactMouseEvent<HTMLDivElement>, image: UploadedImage) => {
    if (settings.layout !== "custom") return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedLayerId(image.id);
    pushHistory();

    const startClientX = event.clientX;
    const startScale = image.scale;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = (moveEvent.clientX - startClientX) / 180;
      const nextScale = Math.max(0.05, Number((startScale + delta).toFixed(3)));
      setImages((prev) => prev.map((img) => (img.id === image.id ? { ...img, scale: nextScale } : img)));
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const canvasPreset = (value: string) => {
    const map: Record<string, { width: number; height: number }> = {
      hd: { width: 1280, height: 720 },
      fhd: { width: 1920, height: 1080 },
      qhd: { width: 2560, height: 1440 },
      uhd: { width: 3840, height: 2160 },
    };
    const picked = map[value];
    if (!picked) return;
    pushHistory();
    setSettings((prev) => ({ ...prev, canvasWidth: picked.width, canvasHeight: picked.height }));
  };

  const drawImageIntoRect = (
    ctx: CanvasRenderingContext2D,
    bitmap: ImageBitmap,
    x: number,
    y: number,
    width: number,
    height: number,
    fitMode: FitMode,
  ) => {
    if (fitMode === "stretch") {
      ctx.drawImage(bitmap, x, y, width, height);
      return;
    }
    if (fitMode === "fill") {
      drawCover(ctx, bitmap, x, y, width, height);
      return;
    }
    drawContain(ctx, bitmap, x, y, width, height);
  };

  const calculateCustomCanvas = (layers: UploadedImage[]) => {
    let minX = 0;
    let minY = 0;
    let maxX = settings.canvasWidth;
    let maxY = settings.canvasHeight;

    for (const layer of layers) {
      const width = layer.currentWidth * layer.scale;
      const height = layer.currentHeight * layer.scale;
      const bounds = getRotatedBounds(layer.x, layer.y, width, height, layer.rotation);
      minX = Math.min(minX, bounds.left);
      minY = Math.min(minY, bounds.top);
      maxX = Math.max(maxX, bounds.right);
      maxY = Math.max(maxY, bounds.bottom);
    }

    let width = Math.ceil(maxX - minX);
    let height = Math.ceil(maxY - minY);
    let shiftX = minX < 0 ? -minX : 0;
    let shiftY = minY < 0 ? -minY : 0;

    if (!settings.autoExpandCanvas) {
      width = settings.canvasWidth;
      height = settings.canvasHeight;
      shiftX = 0;
      shiftY = 0;
    }

    return {
      width,
      height,
      shiftX,
      shiftY,
    };
  };

  const runMerge = async () => {
    if (images.length === 0) {
      addToast("Please upload at least two images to merge.", "error");
      return;
    }
    if (images.length === 1) {
      addToast("Add at least one more image to create a merged image.", "error");
      return;
    }

    setIsMerging(true);
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    const bitmaps = new Map<string, ImageBitmap>();

    try {
      for (const image of images) {
        bitmaps.set(image.id, await createImageBitmap(image.file));
      }

      let canvasWidth = 0;
      let canvasHeight = 0;
      let drawOps: Array<{
        image: UploadedImage;
        x: number;
        y: number;
        width: number;
        height: number;
      }> = [];

      if (settings.layout === "custom") {
        const customCanvas = calculateCustomCanvas(images);
        canvasWidth = customCanvas.width;
        canvasHeight = customCanvas.height;
        drawOps = images.map((image) => ({
          image,
          x: image.x + customCanvas.shiftX,
          y: image.y + customCanvas.shiftY,
          width: image.currentWidth * image.scale,
          height: image.currentHeight * image.scale,
        }));
      } else {
        const cols =
          settings.layout === "vertical"
            ? 1
            : settings.layout === "horizontal"
              ? images.length
              : Math.max(1, Math.min(gridColumns, images.length));
        const rows = Math.ceil(images.length / cols);

        const baseBoxes = images.map((image) => ({ width: image.currentWidth, height: image.currentHeight }));
        const maxW = Math.max(...baseBoxes.map((item) => item.width));
        const maxH = Math.max(...baseBoxes.map((item) => item.height));

        const boxes = baseBoxes.map((box) => {
          if (settings.fit === "match-width") {
            return { width: maxW, height: Math.round((box.height / box.width) * maxW) };
          }
          if (settings.fit === "match-height") {
            return { width: Math.round((box.width / box.height) * maxH), height: maxH };
          }
          if (settings.fit === "stretch" || settings.fit === "fill") {
            return { width: maxW, height: maxH };
          }
          if (settings.fit === "fit" && settings.layout === "horizontal") {
            return { width: Math.round((box.width / box.height) * maxH), height: maxH };
          }
          if (settings.fit === "fit" && settings.layout === "vertical") {
            return { width: maxW, height: Math.round((box.height / box.width) * maxW) };
          }
          return { ...box };
        });

        const colWidths = Array.from({ length: cols }, () => 0);
        const rowHeights = Array.from({ length: rows }, () => 0);
        boxes.forEach((box, index) => {
          const col = index % cols;
          const row = Math.floor(index / cols);
          colWidths[col] = Math.max(colWidths[col], box.width + (settings.borderEnabled ? settings.borderThickness * 2 : 0));
          rowHeights[row] = Math.max(rowHeights[row], box.height + (settings.borderEnabled ? settings.borderThickness * 2 : 0));
        });

        canvasWidth = colWidths.reduce((sum, width) => sum + width, 0) + settings.spacing * (cols - 1);
        canvasHeight = rowHeights.reduce((sum, height) => sum + height, 0) + settings.spacing * (rows - 1);

        const colOffsets = colWidths.map((_, col) => {
          const before = colWidths.slice(0, col).reduce((sum, width) => sum + width, 0);
          return before + settings.spacing * col;
        });
        const rowOffsets = rowHeights.map((_, row) => {
          const before = rowHeights.slice(0, row).reduce((sum, height) => sum + height, 0);
          return before + settings.spacing * row;
        });

        drawOps = images.map((image, index) => {
          const box = boxes[index];
          const col = index % cols;
          const row = Math.floor(index / cols);
          const slotW = colWidths[col];
          const slotH = rowHeights[row];
          const border = settings.borderEnabled ? settings.borderThickness * 2 : 0;
          const x = colOffsets[col] + (slotW - (box.width + border)) / 2;
          const y = rowOffsets[row] + (slotH - (box.height + border)) / 2;
          return {
            image,
            x,
            y,
            width: box.width,
            height: box.height,
          };
        });
      }

      if (
        canvasWidth > MAX_CANVAS_EDGE ||
        canvasHeight > MAX_CANVAS_EDGE ||
        canvasWidth * canvasHeight > MAX_CANVAS_PIXELS
      ) {
        throw new Error("CANVAS_LIMIT");
      }

      const canvas = document.createElement("canvas");
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas context unavailable");

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      if (settings.spacing > 0) {
        ctx.fillStyle = settings.spacingColor;
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      } else {
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      }

      if (effectiveBackground !== "transparent") {
        ctx.fillStyle = effectiveBackground;
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      }

      for (const operation of drawOps) {
        const bitmap = bitmaps.get(operation.image.id);
        if (!bitmap) continue;

        const border = settings.borderEnabled ? settings.borderThickness : 0;
        const drawX = operation.x;
        const drawY = operation.y;
        const drawW = operation.width;
        const drawH = operation.height;

        if (settings.layout === "custom") {
          const angle = (operation.image.rotation * Math.PI) / 180;
          const cx = drawX + drawW / 2;
          const cy = drawY + drawH / 2;

          if (settings.borderEnabled && border > 0) {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(angle);
            ctx.fillStyle = settings.borderColor;
            drawRoundedRectPath(
              ctx,
              -drawW / 2 - border,
              -drawH / 2 - border,
              drawW + border * 2,
              drawH + border * 2,
              settings.borderRadius,
            );
            ctx.fill();
            ctx.restore();
          }

          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(angle);

          if (settings.borderEnabled && settings.borderRadius > 0) {
            drawRoundedRectPath(ctx, -drawW / 2, -drawH / 2, drawW, drawH, Math.max(0, settings.borderRadius - border));
            ctx.clip();
          }

          drawImageIntoRect(ctx, bitmap, -drawW / 2, -drawH / 2, drawW, drawH, settings.fit);
          ctx.restore();
          continue;
        }

        if (settings.borderEnabled && border > 0) {
          ctx.fillStyle = settings.borderColor;
          drawRoundedRectPath(ctx, drawX, drawY, drawW + border * 2, drawH + border * 2, settings.borderRadius);
          ctx.fill();
        }

        const innerX = drawX + border;
        const innerY = drawY + border;
        const innerW = drawW;
        const innerH = drawH;

        if (settings.borderEnabled && settings.borderRadius > 0) {
          ctx.save();
          drawRoundedRectPath(
            ctx,
            innerX,
            innerY,
            innerW,
            innerH,
            Math.max(0, settings.borderRadius - border / 2),
          );
          ctx.clip();
        }

        drawImageIntoRect(ctx, bitmap, innerX, innerY, innerW, innerH, settings.fit);

        if (settings.borderEnabled && settings.borderRadius > 0) {
          ctx.restore();
        }
      }

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (nextBlob) => {
            if (!nextBlob) {
              reject(new Error("Failed to generate output file."));
              return;
            }
            resolve(nextBlob);
          },
          mimeForFormat(settings.exportFormat),
          settings.exportFormat === "png" ? undefined : settings.quality / 100,
        );
      });

      resetResult();
      const nextUrl = URL.createObjectURL(blob);
      const nextResult: MergeResult = {
        url: nextUrl,
        blob,
        width: canvasWidth,
        height: canvasHeight,
        format: settings.exportFormat,
        imageCount: images.length,
        totalPixels: canvasWidth * canvasHeight,
      };
      setResult(nextResult);
      setResultViewer({ zoom: 1, fit: true, fullscreen: false });
      addToast("Merged image preview is ready.", "success");
    } catch (error) {
      if (error instanceof Error && error.message === "CANVAS_LIMIT") {
        addToast(
          "The requested output is larger than this browser can safely process at full resolution. Reduce canvas dimensions or merge fewer images.",
          "error",
        );
      } else {
        addToast("Unable to merge images right now. Please try again.", "error");
      }
    } finally {
      bitmaps.forEach((bitmap) => bitmap.close());
      setIsMerging(false);
    }
  };

  const saveFile = async (blob: Blob, fileName: string, mimeType: string, extension: string, description: string) => {
    const pickerWindow = window as SaveFilePickerWindow;
    if (!pickerWindow.showSaveFilePicker) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      addToast("Download started. Choose a save location in your browser's download settings.", "info");
      return;
    }

    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description, accept: { [mimeType]: [extension] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      addToast(`${description} saved successfully.`, "success");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      addToast(
        error instanceof Error ? `Unable to save ${description.toLowerCase()}: ${error.message}` : `Unable to save ${description.toLowerCase()}.`,
        "error",
      );
    }
  };

  const downloadResult = () => {
    if (!result) return;
    const safeName = sanitizeFileName(settings.filename, "merged-image");
    const extension = extForFormat(result.format);
    void saveFile(result.blob, `${safeName}.${extension}`, mimeForFormat(result.format), `.${extension}`, "Image");
  };

  const createMultipagePdf = async () => {
    if (images.length === 0 || isMerging || isCreatingPdf) return;

    setIsCreatingPdf(true);
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    const pages: PdfPagePreview[] = [];
    const border = settings.borderEnabled ? settings.borderThickness : 0;
    const pageMime = settings.exportFormat === "jpeg" ? "image/jpeg" : "image/png";

    try {
      for (const image of images) {
        const bitmap = await createImageBitmap(image.file);
        try {
          const width = Math.max(1, Math.round(image.currentWidth * image.scale));
          const height = Math.max(1, Math.round(image.currentHeight * image.scale));
          const bounds = getRotatedBounds(0, 0, width, height, image.rotation);
          const canvasWidth = Math.ceil(bounds.width) + border * 2;
          const canvasHeight = Math.ceil(bounds.height) + border * 2;

          if (
            !Number.isFinite(canvasWidth) ||
            !Number.isFinite(canvasHeight) ||
            canvasWidth > MAX_CANVAS_EDGE ||
            canvasHeight > MAX_CANVAS_EDGE ||
            canvasWidth * canvasHeight > MAX_CANVAS_PIXELS
          ) {
            throw new Error("CANVAS_LIMIT");
          }

          const canvas = document.createElement("canvas");
          canvas.width = canvasWidth;
          canvas.height = canvasHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Canvas context unavailable");

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          if (effectiveBackground !== "transparent") {
            ctx.fillStyle = effectiveBackground;
            ctx.fillRect(0, 0, canvasWidth, canvasHeight);
          }

          ctx.save();
          ctx.translate(canvasWidth / 2, canvasHeight / 2);
          ctx.rotate((image.rotation * Math.PI) / 180);

          if (border > 0) {
            ctx.fillStyle = settings.borderColor;
            drawRoundedRectPath(
              ctx,
              -width / 2 - border,
              -height / 2 - border,
              width + border * 2,
              height + border * 2,
              settings.borderRadius,
            );
            ctx.fill();
          }

          if (settings.borderEnabled && settings.borderRadius > 0) {
            drawRoundedRectPath(
              ctx,
              -width / 2,
              -height / 2,
              width,
              height,
              Math.max(0, settings.borderRadius - border / 2),
            );
            ctx.clip();
          }

          drawImageIntoRect(ctx, bitmap, -width / 2, -height / 2, width, height, settings.fit);
          ctx.restore();

          const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (output) => {
                if (!output) {
                  reject(new Error(`Failed to render PDF page for ${image.name}.`));
                  return;
                }
                resolve(output);
              },
              pageMime,
              pageMime === "image/jpeg" ? settings.quality / 100 : undefined,
            );
          });

          pages.push({
            id: makeId(),
            name: image.name,
            url: URL.createObjectURL(blob),
            blob,
            width: canvasWidth,
            height: canvasHeight,
          });
        } finally {
          bitmap.close();
        }
      }

      const maxPdfPageEdge = 14400;
      const getPageSize = (page: PdfPagePreview) => {
        const scale = Math.min(1, maxPdfPageEdge / page.width, maxPdfPageEdge / page.height);
        return [page.width * scale, page.height * scale] as const;
      };
      const [firstWidth, firstHeight] = getPageSize(pages[0]);
      const pdf = new jsPDF({
        unit: "pt",
        format: [firstWidth, firstHeight],
        compress: true,
      });

      for (const [index, page] of pages.entries()) {
        const [pageWidth, pageHeight] = getPageSize(page);
        if (index > 0) {
          pdf.addPage([pageWidth, pageHeight], pageWidth > pageHeight ? "landscape" : "portrait");
        }

        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === "string") resolve(reader.result);
            else reject(new Error(`Failed to read PDF page for ${page.name}.`));
          };
          reader.onerror = () => reject(reader.error ?? new Error(`Failed to read PDF page for ${page.name}.`));
          reader.readAsDataURL(page.blob);
        });

        pdf.addImage(dataUrl, pageMime === "image/jpeg" ? "JPEG" : "PNG", 0, 0, pageWidth, pageHeight, undefined, "FAST");
      }

      const blob = pdf.output("blob");
      resetResult();
      setPdfPages(pages);
      setPdfBlob(blob);
      addToast(`Created one PDF with ${pages.length} page${pages.length === 1 ? "" : "s"}.`, "success");
    } catch (error) {
      pages.forEach((page) => URL.revokeObjectURL(page.url));
      if (error instanceof Error && error.message === "CANVAS_LIMIT") {
        addToast("One or more images exceed this browser's safe canvas size. Reduce their dimensions and try again.", "error");
      } else {
        addToast(error instanceof Error ? `Unable to create PDF: ${error.message}` : "Unable to create PDF.", "error");
      }
    } finally {
      setIsCreatingPdf(false);
    }
  };

  const saveMultipagePdf = async () => {
    if (!pdfBlob) return;

    const fileName = `${sanitizeFileName(settings.filename, "images")}.pdf`;
    await saveFile(pdfBlob, fileName, "application/pdf", ".pdf", "PDF document");
  };

  const onUploadZoneKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openUploadPicker();
    }
  };

  const exportQualityLabel = settings.exportFormat === "png" ? "Lossless" : `${settings.quality}%`;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#050505] text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="glow-orb left-[-16%] top-[-16%] h-[38rem] w-[38rem] bg-[radial-gradient(circle_at_center,rgba(168,85,247,0.44),transparent_66%)]" />
        <div className="glow-orb right-[-14%] top-[3%] h-[32rem] w-[32rem] bg-[radial-gradient(circle_at_center,rgba(250,204,21,0.3),transparent_65%)]" />
        <div className="glow-orb left-[12%] top-[42%] h-[30rem] w-[30rem] bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.33),transparent_66%)]" />
        <div className="glow-orb right-[6%] top-[44%] h-[29rem] w-[29rem] bg-[radial-gradient(circle_at_center,rgba(34,197,94,0.28),transparent_66%)]" />
        <div className="glow-orb left-[42%] bottom-[-22%] h-[35rem] w-[35rem] bg-[radial-gradient(circle_at_center,rgba(244,63,94,0.28),transparent_65%)]" />
        <div className="gloss-streak top-[20%]" />
        <div className="gloss-streak bottom-[15%]" />
      </div>

      <div className="relative z-10">
        {!started ? (
          <section className="flex min-h-screen items-center justify-center px-6">
            <div className="mx-auto max-w-4xl text-center">
              <h1 className="chrome-title text-[clamp(2.8rem,9vw,6.7rem)] font-extrabold leading-[0.95] tracking-tight">
                Image Merger
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-[clamp(1rem,2.3vw,1.45rem)] italic text-zinc-300">
                Combine images into one picture or put each image on its own page in a single PDF.
              </p>
              <button
                type="button"
                onClick={() => setStarted(true)}
                className="group relative mt-11 inline-flex items-center gap-2 rounded-2xl border border-white/20 bg-white/5 px-8 py-4 text-lg font-semibold text-white backdrop-blur-xl transition duration-200 hover:scale-[1.03] hover:shadow-[0_0_35px_rgba(56,189,248,0.5)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
              >
                <span className="absolute inset-0 rounded-2xl bg-[conic-gradient(from_160deg,#38bdf8,#a855f7,#fb923c,#facc15,#0ea5e9,#22d3ee,#a855f7)] opacity-80 blur-sm transition duration-200 group-hover:opacity-100" />
                <span className="absolute inset-[1px] rounded-2xl bg-[#090909de] backdrop-blur-xl" />
                <span className="relative">Get Started</span>
                <span className="relative transition-transform duration-200 group-hover:translate-x-1" aria-hidden="true">
                  &rarr;
                </span>
              </button>
            </div>
          </section>
        ) : (
          <main className="animate-enter pb-20 pt-10 md:pt-14">
            <div className="mx-auto w-[min(1160px,88vw)]">
              <header className="text-center">
                <h1 className="bg-gradient-to-b from-white via-zinc-200 to-zinc-500 bg-clip-text text-4xl font-bold tracking-tight text-transparent md:text-6xl">
                  Image Merger
                </h1>
                <p className="mt-3 text-zinc-300 md:text-lg">
                  Merge images into one picture or create one multi-page PDF with a different image on each page.
                </p>
                <p className="mt-2 text-sm text-zinc-400">
                  Private by design - your images are processed locally in your browser whenever possible.
                </p>
              </header>

              <section className="glass mt-10 rounded-3xl border border-white/10 p-4 md:p-6">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={openUploadPicker}
                  onKeyDown={onUploadZoneKeyDown}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setIsDraggingUpload(true);
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                    setIsDraggingUpload(false);
                  }}
                  onDrop={onDropUpload}
                  className={`upload-zone cursor-pointer rounded-2xl border px-4 py-12 text-center transition md:px-10 ${
                    isDraggingUpload
                      ? "border-cyan-300 bg-cyan-400/10 shadow-[0_0_40px_rgba(34,211,238,0.3)]"
                      : "border-white/20"
                  }`}
                  aria-label="Drag and drop images here or click to browse files"
                >
                  <p className="text-2xl font-semibold tracking-tight md:text-3xl">Drag &amp; Drop Images Here</p>
                  <p className="mt-3 text-zinc-300">or click to browse files</p>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openUploadPicker();
                    }}
                    className="group relative mt-8 inline-flex rounded-xl border border-white/20 px-6 py-3 text-base font-semibold transition duration-200 hover:scale-[1.02] hover:shadow-[0_0_28px_rgba(168,85,247,0.35)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fuchsia-400"
                  >
                    <span className="absolute inset-0 rounded-xl bg-[linear-gradient(110deg,rgba(34,211,238,0.45),rgba(56,189,248,0.45),rgba(168,85,247,0.46),rgba(251,146,60,0.42),rgba(250,204,21,0.42))]" />
                    <span className="absolute inset-[1px] rounded-[11px] bg-black/70" />
                    <span className="relative">Upload Images</span>
                  </button>
                  <p className="mt-6 text-xs uppercase tracking-[0.2em] text-zinc-400">
                    Supports JPG, JPEG, PNG, WEBP · Files stay on your device
                  </p>
                </div>
                <input
                  ref={uploadInputRef}
                  type="file"
                  multiple
                  accept="image/jpeg,image/jpg,image/png,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    void processFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </section>

              {images.length > 0 && (
                <section className="mt-8">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-2xl font-semibold tracking-tight">Uploaded Images</h2>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={undo}
                        disabled={historyPast.length === 0}
                        className="rounded-lg border border-white/20 px-3 py-2 text-sm text-zinc-200 transition hover:border-cyan-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        Undo
                      </button>
                      <button
                        type="button"
                        onClick={redo}
                        disabled={historyFuture.length === 0}
                        className="rounded-lg border border-white/20 px-3 py-2 text-sm text-zinc-200 transition hover:border-cyan-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        Redo
                      </button>
                      <button
                        type="button"
                        onClick={() => clearImages(true)}
                        className="rounded-lg border border-white/20 px-3 py-2 text-sm text-zinc-200 transition hover:border-red-300 hover:text-white"
                      >
                        Clear Images
                      </button>
                      <button
                        type="button"
                        onClick={resetSettings}
                        className="rounded-lg border border-white/20 px-3 py-2 text-sm text-zinc-200 transition hover:border-violet-300 hover:text-white"
                      >
                        Reset Settings
                      </button>
                    </div>
                  </div>

                  <div className="grid max-h-[30rem] gap-3 overflow-auto rounded-2xl pr-1 md:grid-cols-2 lg:grid-cols-3">
                    {images.map((image, index) => {
                      const status = getQualityStatus(image);
                      const upscaled = status === "Upscaled";
                      return (
                        <article
                          key={image.id}
                          draggable
                          onDragStart={() => {
                            pushHistory();
                            setDraggedCardId(image.id);
                            replaceDragCache.current = image.id;
                          }}
                          onDragOver={(event) => {
                            event.preventDefault();
                            if (!draggedCardId || draggedCardId === image.id || replaceDragCache.current === image.id) return;
                            setImages((prev) => {
                              const from = prev.findIndex((item) => item.id === draggedCardId);
                              const to = prev.findIndex((item) => item.id === image.id);
                              if (from < 0 || to < 0 || from === to) return prev;
                              return moveItem(prev, from, to);
                            });
                            replaceDragCache.current = image.id;
                          }}
                          onDragEnd={() => {
                            setDraggedCardId(null);
                            replaceDragCache.current = null;
                          }}
                          className={`glass rounded-2xl border p-3 transition ${
                            draggedCardId === image.id ? "border-cyan-300/80 shadow-[0_0_32px_rgba(34,211,238,0.25)]" : "border-white/10"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setSelectedLayerId(image.id)}
                            className="relative block w-full overflow-hidden rounded-xl border border-white/10"
                          >
                            <img src={image.url} alt={image.name} loading="lazy" className="h-36 w-full object-cover" />
                            <span className="absolute left-2 top-2 rounded-md border border-white/20 bg-black/65 px-2 py-1 text-xs text-zinc-200">
                              #{index + 1}
                            </span>
                          </button>

                          <div className="mt-3 space-y-1 text-sm text-zinc-200">
                            <p className="truncate font-medium text-white" title={image.name}>
                              {image.name}
                            </p>
                            <p>
                              Original: {image.originalWidth} x {image.originalHeight}px
                            </p>
                            <p>
                              Current: {image.currentWidth} x {image.currentHeight}px
                            </p>
                            <p className="uppercase">{(image.type.split("/")[1] || "image").replace("jpeg", "jpg")}</p>
                            <p>{formatBytes(image.size)}</p>
                            <p
                              className={`text-xs font-medium ${
                                status === "Original Quality"
                                  ? "text-emerald-300"
                                  : upscaled
                                    ? "text-amber-300"
                                    : "text-cyan-300"
                              }`}
                            >
                              {status}
                            </p>
                          </div>

                          <div className="mt-3 grid grid-cols-3 gap-2">
                            <button
                              type="button"
                              onClick={() => setPreviewState({ imageId: image.id, zoom: 1, fit: true })}
                              className="rounded-lg border border-cyan-300/40 bg-cyan-400/10 px-2 py-1.5 text-xs font-medium text-cyan-100 transition hover:border-cyan-200 hover:text-white"
                            >
                              Preview
                            </button>
                            <button
                              type="button"
                              onClick={() => openResizeModal(image)}
                              className="rounded-lg border border-violet-300/40 bg-violet-400/10 px-2 py-1.5 text-xs font-medium text-violet-100 transition hover:border-yellow-200 hover:text-white"
                            >
                              Resize
                            </button>
                            <button
                              type="button"
                              onClick={() => removeImage(image.id)}
                              className="rounded-lg border border-rose-300/40 bg-rose-400/10 px-2 py-1.5 text-xs font-medium text-rose-100 transition hover:border-orange-200 hover:text-white"
                            >
                              Remove
                            </button>
                          </div>

                          <button
                            type="button"
                            onClick={() => resetSingleImage(image.id)}
                            className="mt-2 w-full rounded-lg border border-white/20 px-2 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-cyan-300 hover:text-white"
                          >
                            Reset Image
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </section>
              )}

              <section className="mt-10 grid gap-4 md:grid-cols-2">
                <div className="glass rounded-2xl border border-white/10 p-4">
                  <h3 className="text-xl font-semibold">Basic</h3>
                  <label className="mt-3 block text-sm text-zinc-200" htmlFor="layout-select">
                    Merge Layout
                  </label>
                  <select
                    id="layout-select"
                    value={settings.layout}
                    onChange={(event) => setSettings((prev) => ({ ...prev, layout: event.target.value as LayoutMode }))}
                    className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white focus:border-cyan-300 focus:outline-none"
                  >
                    <option value="vertical">Vertical</option>
                    <option value="horizontal">Horizontal</option>
                    <option value="grid">Grid</option>
                    <option value="custom">Custom</option>
                  </select>

                  <label className="mt-4 block text-sm text-zinc-200" htmlFor="fit-mode">
                    Image Fit
                  </label>
                  <select
                    id="fit-mode"
                    value={settings.fit}
                    onChange={(event) => setSettings((prev) => ({ ...prev, fit: event.target.value as FitMode }))}
                    className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white focus:border-cyan-300 focus:outline-none"
                  >
                    <option value="original">Original Size</option>
                    <option value="fit">Fit</option>
                    <option value="fill">Fill</option>
                    <option value="stretch">Stretch</option>
                    <option value="match-width">Match Width</option>
                    <option value="match-height">Match Height</option>
                  </select>

                  {settings.layout === "grid" && (
                    <>
                      <label className="mt-4 block text-sm text-zinc-200" htmlFor="grid-mode">
                        Grid Columns
                      </label>
                      <select
                        id="grid-mode"
                        value={settings.gridMode}
                        onChange={(event) => setSettings((prev) => ({ ...prev, gridMode: event.target.value as GridMode }))}
                        className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white focus:border-cyan-300 focus:outline-none"
                      >
                        <option value="auto">Auto</option>
                        <option value="2">2 columns</option>
                        <option value="3">3 columns</option>
                        <option value="4">4 columns</option>
                        <option value="custom">Custom columns</option>
                      </select>
                      {settings.gridMode === "custom" && (
                        <input
                          type="number"
                          min={1}
                          max={12}
                          value={settings.customColumns}
                          onChange={(event) =>
                            setSettings((prev) => ({ ...prev, customColumns: Number(event.target.value) || 1 }))
                          }
                          className="mt-2 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white focus:border-cyan-300 focus:outline-none"
                        />
                      )}
                    </>
                  )}

                  <label className="mt-4 block text-sm text-zinc-200" htmlFor="spacing">
                    Spacing ({settings.spacing}px)
                  </label>
                  <input
                    id="spacing"
                    type="range"
                    min={0}
                    max={100}
                    value={settings.spacing}
                    onChange={(event) => setSettings((prev) => ({ ...prev, spacing: Number(event.target.value) || 0 }))}
                    className="mt-2 w-full accent-cyan-400"
                  />

                  {settings.spacing > 0 && (
                    <label className="mt-3 block text-sm text-zinc-200">
                      Spacing Color
                      <input
                        type="color"
                        value={settings.spacingColor}
                        onChange={(event) => setSettings((prev) => ({ ...prev, spacingColor: event.target.value }))}
                        className="mt-2 h-10 w-full rounded-lg border border-white/20 bg-black/50 px-2"
                      />
                    </label>
                  )}
                </div>

                <div className="glass rounded-2xl border border-white/10 p-4">
                  <h3 className="text-xl font-semibold">Advanced</h3>

                  <label className="mt-3 block text-sm text-zinc-200">Background</label>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      { value: "white", label: "White" },
                      { value: "black", label: "Black" },
                      { value: "transparent", label: "Transparent" },
                      { value: "custom", label: "Custom" },
                    ].map((option) => {
                      const disabled = option.value === "transparent" && !transparencyAvailable;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            setSettings((prev) => ({
                              ...prev,
                              backgroundMode: option.value as BackgroundMode,
                            }))
                          }
                          className={`rounded-lg border px-2 py-2 text-sm transition ${
                            settings.backgroundMode === option.value
                              ? "border-cyan-300 bg-cyan-400/10 text-white"
                              : "border-white/20 text-zinc-300 hover:text-white"
                          } ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  {!transparencyAvailable && (
                    <p className="mt-2 text-xs text-zinc-400">Transparent background is disabled for JPEG exports.</p>
                  )}
                  {settings.backgroundMode === "custom" && (
                    <input
                      type="color"
                      value={settings.customBackground}
                      onChange={(event) => setSettings((prev) => ({ ...prev, customBackground: event.target.value }))}
                      className="mt-2 h-10 w-full rounded-lg border border-white/20 bg-black/50 px-2"
                    />
                  )}

                  <div className="mt-4">
                    <label className="inline-flex items-center gap-2 text-sm text-zinc-200">
                      <input
                        type="checkbox"
                        checked={settings.borderEnabled}
                        onChange={(event) => setSettings((prev) => ({ ...prev, borderEnabled: event.target.checked }))}
                        className="h-4 w-4 accent-cyan-400"
                      />
                      Border
                    </label>
                  </div>

                  {settings.borderEnabled && (
                    <div className="mt-3 space-y-3">
                      <label className="block text-sm text-zinc-200">
                        Thickness ({settings.borderThickness}px)
                        <input
                          type="range"
                          min={1}
                          max={50}
                          value={settings.borderThickness}
                          onChange={(event) =>
                            setSettings((prev) => ({ ...prev, borderThickness: Number(event.target.value) || 1 }))
                          }
                          className="mt-2 w-full accent-cyan-400"
                        />
                      </label>
                      <label className="block text-sm text-zinc-200">
                        Radius ({settings.borderRadius}px)
                        <input
                          type="range"
                          min={0}
                          max={120}
                          value={settings.borderRadius}
                          onChange={(event) =>
                            setSettings((prev) => ({ ...prev, borderRadius: Number(event.target.value) || 0 }))
                          }
                          className="mt-2 w-full accent-cyan-400"
                        />
                      </label>
                      <label className="block text-sm text-zinc-200">
                        Border Color
                        <input
                          type="color"
                          value={settings.borderColor}
                          onChange={(event) => setSettings((prev) => ({ ...prev, borderColor: event.target.value }))}
                          className="mt-2 h-10 w-full rounded-lg border border-white/20 bg-black/50 px-2"
                        />
                      </label>
                    </div>
                  )}
                </div>
              </section>

              {settings.layout === "custom" && images.length > 0 && (
                <section className="glass mt-8 rounded-2xl border border-white/10 p-4 md:p-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-xl font-semibold">Adjust Positions</h3>
                    <div className="flex flex-wrap gap-2">
                      <select
                        onChange={(event) => {
                          canvasPreset(event.target.value);
                          event.target.value = "";
                        }}
                        className="rounded-lg border border-white/20 bg-black/40 px-2 py-2 text-sm text-white"
                        defaultValue=""
                      >
                        <option value="" disabled>
                          Canvas Presets
                        </option>
                        <option value="hd">HD - 1280 x 720</option>
                        <option value="fhd">Full HD - 1920 x 1080</option>
                        <option value="qhd">2K - 2560 x 1440</option>
                        <option value="uhd">4K UHD - 3840 x 2160</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                    <label className="text-sm text-zinc-200">
                      Canvas Width
                      <input
                        type="number"
                        min={1}
                        value={settings.canvasWidth}
                        onChange={(event) =>
                          setSettings((prev) => ({ ...prev, canvasWidth: Math.max(1, Number(event.target.value) || 1) }))
                        }
                        className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white"
                      />
                    </label>
                    <label className="text-sm text-zinc-200">
                      Canvas Height
                      <input
                        type="number"
                        min={1}
                        value={settings.canvasHeight}
                        onChange={(event) =>
                          setSettings((prev) => ({ ...prev, canvasHeight: Math.max(1, Number(event.target.value) || 1) }))
                        }
                        className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white"
                      />
                    </label>
                    <label className="col-span-2 inline-flex items-center gap-2 text-sm text-zinc-200 md:mt-7">
                      <input
                        type="checkbox"
                        checked={settings.autoExpandCanvas}
                        onChange={(event) => setSettings((prev) => ({ ...prev, autoExpandCanvas: event.target.checked }))}
                        className="h-4 w-4 accent-cyan-400"
                      />
                      Auto-expand canvas to fit all images
                    </label>
                  </div>

                  <div className="mt-4 overflow-auto rounded-2xl border border-white/15 bg-black/45 p-4">
                    <div
                      className="relative mx-auto border border-white/15 bg-[#0b0b0b]"
                      style={{
                        width: Math.max(320, Math.round(settings.canvasWidth * customDisplayScale)),
                        height: Math.max(220, Math.round(settings.canvasHeight * customDisplayScale)),
                      }}
                    >
                      {images.map((image) => {
                        const width = image.currentWidth * image.scale;
                        const height = image.currentHeight * image.scale;
                        const isSelected = image.id === selectedLayerId;
                        const upscaled = width > image.originalWidth || height > image.originalHeight;
                        return (
                          <div
                            key={image.id}
                            role="button"
                            tabIndex={0}
                            onMouseDown={(event) => onDragLayerStart(event, image)}
                            onClick={() => setSelectedLayerId(image.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") setSelectedLayerId(image.id);
                            }}
                            className={`absolute overflow-hidden border transition ${
                              isSelected ? "border-cyan-300 shadow-[0_0_24px_rgba(34,211,238,0.45)]" : "border-white/25"
                            }`}
                            style={{
                              left: image.x * customDisplayScale,
                              top: image.y * customDisplayScale,
                              width: width * customDisplayScale,
                              height: height * customDisplayScale,
                              transform: `rotate(${image.rotation}deg)`,
                              transformOrigin: "center center",
                              zIndex: images.findIndex((item) => item.id === image.id) + 1,
                            }}
                          >
                            <img src={image.url} alt={image.name} className="h-full w-full object-cover" draggable={false} />
                            {isSelected && (
                              <>
                                <div
                                  className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize rounded-tl bg-cyan-300"
                                  onMouseDown={(event) => onLayerResizeHandleStart(event, image)}
                                />
                                <div className="absolute left-1 top-1 rounded border border-white/30 bg-black/70 px-1 py-0.5 text-[10px] text-zinc-100">
                                  {Math.round(width)} x {Math.round(height)}
                                </div>
                                {upscaled && (
                                  <div className="absolute bottom-1 left-1 rounded border border-amber-300/40 bg-black/70 px-1 py-0.5 text-[10px] text-amber-200">
                                    Upscaled
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {selectedLayer && (
                    <div className="mt-4 grid gap-3 lg:grid-cols-2">
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-zinc-200">Selected Layer: {selectedLayer.name}</p>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-sm text-zinc-300">
                            X Position
                            <input
                              type="number"
                              value={Math.round(selectedLayer.x)}
                              onFocus={pushHistory}
                              onChange={(event) => {
                                const value = Number(event.target.value) || 0;
                                setImages((prev) => prev.map((img) => (img.id === selectedLayer.id ? { ...img, x: value } : img)));
                              }}
                              className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white"
                            />
                          </label>
                          <label className="text-sm text-zinc-300">
                            Y Position
                            <input
                              type="number"
                              value={Math.round(selectedLayer.y)}
                              onFocus={pushHistory}
                              onChange={(event) => {
                                const value = Number(event.target.value) || 0;
                                setImages((prev) => prev.map((img) => (img.id === selectedLayer.id ? { ...img, y: value } : img)));
                              }}
                              className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white"
                            />
                          </label>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-sm text-zinc-300">
                            Rotation ({Math.round(selectedLayer.rotation)}deg)
                            <input
                              type="range"
                              min={0}
                              max={360}
                              value={selectedLayer.rotation}
                              onMouseDown={pushHistory}
                              onChange={(event) => {
                                const value = Number(event.target.value) || 0;
                                setImages((prev) =>
                                  prev.map((img) => (img.id === selectedLayer.id ? { ...img, rotation: value } : img)),
                                );
                              }}
                              className="mt-2 w-full accent-cyan-400"
                            />
                          </label>
                          <label className="text-sm text-zinc-300">
                            Scale ({selectedLayer.scale.toFixed(2)}x)
                            <input
                              type="range"
                              min={0.05}
                              max={4}
                              step={0.01}
                              value={selectedLayer.scale}
                              onMouseDown={pushHistory}
                              onChange={(event) => {
                                const value = Number(event.target.value) || 1;
                                setImages((prev) => prev.map((img) => (img.id === selectedLayer.id ? { ...img, scale: value } : img)));
                              }}
                              className="mt-2 w-full accent-cyan-400"
                            />
                          </label>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setLayerOrder(selectedLayer.id, "forward")}
                            className="rounded-lg border border-white/20 px-3 py-2 text-sm text-zinc-200 hover:border-cyan-300"
                          >
                            Bring Forward
                          </button>
                          <button
                            type="button"
                            onClick={() => setLayerOrder(selectedLayer.id, "backward")}
                            className="rounded-lg border border-white/20 px-3 py-2 text-sm text-zinc-200 hover:border-cyan-300"
                          >
                            Send Backward
                          </button>
                          <button
                            type="button"
                            onClick={() => setLayerOrder(selectedLayer.id, "front")}
                            className="rounded-lg border border-white/20 px-3 py-2 text-sm text-zinc-200 hover:border-cyan-300"
                          >
                            Bring to Front
                          </button>
                          <button
                            type="button"
                            onClick={() => setLayerOrder(selectedLayer.id, "back")}
                            className="rounded-lg border border-white/20 px-3 py-2 text-sm text-zinc-200 hover:border-cyan-300"
                          >
                            Send to Back
                          </button>
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                          <button
                            type="button"
                            onClick={() => alignSelectedLayer("left")}
                            className="rounded-lg border border-white/20 px-2 py-1.5 text-xs text-zinc-200 hover:border-violet-300"
                          >
                            Align Left
                          </button>
                          <button
                            type="button"
                            onClick={() => alignSelectedLayer("center")}
                            className="rounded-lg border border-white/20 px-2 py-1.5 text-xs text-zinc-200 hover:border-violet-300"
                          >
                            Align Center
                          </button>
                          <button
                            type="button"
                            onClick={() => alignSelectedLayer("right")}
                            className="rounded-lg border border-white/20 px-2 py-1.5 text-xs text-zinc-200 hover:border-violet-300"
                          >
                            Align Right
                          </button>
                          <button
                            type="button"
                            onClick={() => alignSelectedLayer("top")}
                            className="rounded-lg border border-white/20 px-2 py-1.5 text-xs text-zinc-200 hover:border-violet-300"
                          >
                            Align Top
                          </button>
                          <button
                            type="button"
                            onClick={() => alignSelectedLayer("middle")}
                            className="rounded-lg border border-white/20 px-2 py-1.5 text-xs text-zinc-200 hover:border-violet-300"
                          >
                            Align Middle
                          </button>
                          <button
                            type="button"
                            onClick={() => alignSelectedLayer("bottom")}
                            className="rounded-lg border border-white/20 px-2 py-1.5 text-xs text-zinc-200 hover:border-violet-300"
                          >
                            Align Bottom
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => rotateSelected(-90)}
                            className="rounded-lg border border-white/20 px-3 py-2 text-sm text-zinc-200 hover:border-amber-300"
                          >
                            Rotate Left 90deg
                          </button>
                          <button
                            type="button"
                            onClick={() => rotateSelected(90)}
                            className="rounded-lg border border-white/20 px-3 py-2 text-sm text-zinc-200 hover:border-amber-300"
                          >
                            Rotate Right 90deg
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <p className="mt-3 text-xs text-zinc-400">
                    Tip: Use arrow keys to nudge selected layer by 1px. Use Shift + Arrow for 10px steps.
                  </p>
                </section>
              )}

              <section className="mt-8 glass rounded-2xl border border-white/10 p-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="block text-sm text-zinc-200" htmlFor="format-select">
                      Export Format
                    </label>
                    <select
                      id="format-select"
                      value={settings.exportFormat}
                      onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
                      className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white focus:border-cyan-300 focus:outline-none"
                    >
                      <option value="png">PNG (Lossless)</option>
                      <option value="jpeg">JPG / JPEG</option>
                      <option value="webp">WEBP</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm text-zinc-200" htmlFor="file-name">
                      File Name
                    </label>
                    <input
                      id="file-name"
                      type="text"
                      value={settings.filename}
                      onChange={(event) => setSettings((prev) => ({ ...prev, filename: event.target.value }))}
                      className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white focus:border-cyan-300 focus:outline-none"
                      placeholder="merged-image"
                    />
                  </div>

                  {settings.exportFormat !== "png" && (
                    <div className="md:col-span-2">
                      <label className="block text-sm text-zinc-200" htmlFor="quality-slider">
                        {settings.exportFormat === "jpeg" ? "JPEG Quality" : "WEBP Quality"} ({settings.quality}%)
                      </label>
                      <input
                        id="quality-slider"
                        type="range"
                        min={70}
                        max={100}
                        step={1}
                        value={settings.quality}
                        onChange={(event) => setSettings((prev) => ({ ...prev, quality: Number(event.target.value) || 100 }))}
                        className="mt-2 w-full accent-cyan-400"
                      />
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => void runMerge()}
                  disabled={!canMerge}
                  className={`group relative mt-6 w-full rounded-xl px-6 py-3 text-lg font-semibold transition duration-200 ${
                    canMerge
                      ? "hover:scale-[1.01] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fuchsia-400"
                      : "cursor-not-allowed opacity-50"
                  }`}
                >
                  <span className="absolute inset-0 rounded-xl bg-[linear-gradient(120deg,rgba(56,189,248,0.55),rgba(139,92,246,0.75),rgba(249,115,22,0.65),rgba(250,204,21,0.55),rgba(34,197,94,0.52))]" />
                  <span className="absolute inset-[1px] rounded-[11px] bg-black/80 backdrop-blur-md" />
                  <span className="relative inline-flex items-center justify-center gap-2">
                    {isMerging ? (
                      <>
                        <span className="loader" aria-hidden="true" />
                        Creating your merged image...
                      </>
                    ) : (
                      "Merge Images"
                    )}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => void createMultipagePdf()}
                  disabled={images.length === 0 || isMerging || isCreatingPdf}
                  className={`mt-3 w-full rounded-xl border px-6 py-3 text-lg font-semibold transition ${
                    images.length > 0 && !isMerging && !isCreatingPdf
                      ? "border-violet-300/60 bg-violet-400/10 text-white hover:border-violet-200 hover:bg-violet-400/20"
                      : "cursor-not-allowed border-white/10 text-zinc-400 opacity-50"
                  }`}
                >
                  {isCreatingPdf ? "Creating multi-page PDF..." : "Create Multi-page PDF"}
                </button>
              </section>

              {result && (
                <section className="glass mt-10 rounded-3xl border border-white/10 p-4 md:p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-2xl font-semibold">Merged Image Preview</h2>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setResultViewer((prev) => ({ ...prev, zoom: Math.min(8, prev.zoom + 0.2), fit: false }))}
                        className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
                      >
                        Zoom In
                      </button>
                      <button
                        type="button"
                        onClick={() => setResultViewer((prev) => ({ ...prev, zoom: Math.max(0.1, prev.zoom - 0.2), fit: false }))}
                        className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
                      >
                        Zoom Out
                      </button>
                      <button
                        type="button"
                        onClick={() => setResultViewer((prev) => ({ ...prev, fit: true, zoom: 1 }))}
                        className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
                      >
                        Fit to Screen
                      </button>
                      <button
                        type="button"
                        onClick={() => setResultViewer((prev) => ({ ...prev, fit: false, zoom: 1 }))}
                        className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
                      >
                        Actual Size
                      </button>
                      <button
                        type="button"
                        onClick={() => setResultViewer((prev) => ({ ...prev, fullscreen: true }))}
                        className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-violet-300"
                      >
                        Fullscreen Preview
                      </button>
                    </div>
                  </div>

                  <div ref={resultWrapRef} className="mt-4 overflow-auto rounded-2xl border border-white/10 bg-black/45 p-3">
                    <img
                      src={result.url}
                      alt="Merged output preview"
                      className={`mx-auto object-contain ${resultViewer.fit ? "max-h-[70vh] w-auto max-w-full" : "h-auto w-auto"}`}
                      style={resultViewer.fit ? undefined : { maxWidth: "none", transform: `scale(${resultViewer.zoom})`, transformOrigin: "top center" }}
                    />
                  </div>

                  <div className="mt-4 grid gap-2 text-sm text-zinc-300 md:grid-cols-2">
                    <p>
                      Final Resolution: {result.width} x {result.height}px
                    </p>
                    <p>Total Pixels: {result.totalPixels.toLocaleString()}</p>
                    <p>Output Format: {result.format.toUpperCase()}</p>
                    <p>Estimated File Size: {formatBytes(result.blob.size)}</p>
                    <p>Images Merged: {result.imageCount}</p>
                    <p>Quality Setting: {exportQualityLabel}</p>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={downloadResult}
                      className="rounded-xl border border-cyan-300/60 bg-cyan-400/10 px-5 py-2.5 font-semibold text-white transition hover:scale-[1.01] hover:shadow-[0_0_24px_rgba(34,211,238,0.35)]"
                    >
                      Save Merged Image...
                    </button>
                    <button
                      type="button"
                      onClick={startNewMerge}
                      className="rounded-xl border border-white/20 px-5 py-2.5 font-semibold text-zinc-200 transition hover:border-red-300 hover:text-white"
                    >
                      Start New Merge
                    </button>
                  </div>
                </section>
              )}

              {pdfPages.length > 0 && pdfBlob && (
                <section className="glass mt-10 rounded-3xl border border-white/10 p-4 md:p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-2xl font-semibold">Multi-page PDF Preview</h2>
                      <p className="mt-1 text-sm text-zinc-300">
                        One PDF with {pdfPages.length} page{pdfPages.length === 1 ? "" : "s"}, in the same order as your uploaded images.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void saveMultipagePdf()}
                      className="rounded-xl border border-violet-300/60 bg-violet-400/10 px-5 py-2.5 font-semibold text-white transition hover:bg-violet-400/20 disabled:cursor-wait disabled:opacity-60"
                    >
                      Save PDF...
                    </button>
                  </div>

                  <div className="mt-5 max-h-[75vh] space-y-4 overflow-y-auto rounded-2xl border border-white/10 bg-black/35 p-3">
                    {pdfPages.map((item, index) => (
                      <article
                        key={item.id}
                        aria-label={`Page ${index + 1} of ${pdfPages.length}`}
                        className="rounded-xl border border-white/10 bg-black/40 p-4"
                      >
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <h3 className="font-semibold">
                              Page {index + 1} of {pdfPages.length}
                            </h3>
                            <p className="break-all text-sm text-zinc-300">{item.name}</p>
                            <p className="text-xs text-zinc-400">
                              {item.width} x {item.height}px
                            </p>
                          </div>
                        </div>
                        <img
                          src={item.url}
                          alt={`PDF page ${index + 1}: ${item.name}`}
                          loading="lazy"
                          className="mx-auto max-h-[55vh] max-w-full rounded-lg object-contain"
                        />
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </main>
        )}
      </div>

      {previewState && previewImage && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={() => setPreviewState(null)}>
          <div
            className="glass flex max-h-[94vh] w-full max-w-6xl flex-col rounded-2xl border border-white/15 p-3 md:p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xl font-semibold">Image Preview</h3>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setPreviewState((prev) => (prev ? { ...prev, fit: false, zoom: Math.min(8, prev.zoom + 0.2) } : prev))
                  }
                  className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
                >
                  Zoom In
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setPreviewState((prev) => (prev ? { ...prev, fit: false, zoom: Math.max(0.1, prev.zoom - 0.2) } : prev))
                  }
                  className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
                >
                  Zoom Out
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewState((prev) => (prev ? { ...prev, fit: true, zoom: 1 } : prev))}
                  className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
                >
                  Fit to Screen
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewState((prev) => (prev ? { ...prev, fit: false, zoom: 1 } : prev))}
                  className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
                >
                  100% View
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewState(null)}
                  className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-red-300"
                >
                  Close
                </button>
              </div>
            </div>

            <div ref={previewWrapRef} className="flex-1 overflow-auto rounded-xl border border-white/10 bg-black/55 p-3">
              <img
                src={previewImage.url}
                alt={previewImage.name}
                className={previewState.fit ? "mx-auto max-h-[70vh] w-auto max-w-full object-contain" : "h-auto w-auto"}
                style={
                  previewState.fit
                    ? undefined
                    : {
                        maxWidth: "none",
                        transform: `scale(${previewState.zoom})`,
                        transformOrigin: "top left",
                      }
                }
                onWheel={(event) => {
                  if (previewState.fit) return;
                  event.preventDefault();
                  setPreviewState((prev) => {
                    if (!prev) return prev;
                    const direction = event.deltaY > 0 ? -0.1 : 0.1;
                    return { ...prev, zoom: Math.max(0.1, Math.min(8, prev.zoom + direction)) };
                  });
                }}
              />
            </div>

            <div className="mt-3 grid gap-1 text-sm text-zinc-200 md:grid-cols-2">
              <p className="truncate text-white" title={previewImage.name}>
                {previewImage.name}
              </p>
              <p>
                {previewImage.originalWidth} x {previewImage.originalHeight}px
              </p>
              <p>
                {(previewImage.type.split("/")[1] || "image").toUpperCase()} • {formatBytes(previewImage.size)}
              </p>
              <p>Aspect Ratio: {getImageAspectText(previewImage.originalWidth, previewImage.originalHeight)}</p>
            </div>
          </div>
        </div>
      )}

      {resizeState && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={() => setResizeState(null)}>
          <div
            className="glass w-full max-w-xl rounded-2xl border border-white/15 p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-xl font-semibold">Resize Image</h3>
            {(() => {
              const target = images.find((img) => img.id === resizeState.imageId);
              if (!target) return null;
              const warningUpscale = resizeState.width > target.originalWidth || resizeState.height > target.originalHeight;
              return (
                <>
                  <p className="mt-2 text-sm text-zinc-300">
                    Original Dimensions: {target.originalWidth} x {target.originalHeight}px
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <label className="text-sm text-zinc-200">
                      Width (px)
                      <input
                        type="number"
                        min={1}
                        value={Math.max(1, Math.round(resizeState.width))}
                        onChange={updateResizeWidth}
                        className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white"
                      />
                    </label>
                    <label className="text-sm text-zinc-200">
                      Height (px)
                      <input
                        type="number"
                        min={1}
                        value={Math.max(1, Math.round(resizeState.height))}
                        onChange={updateResizeHeight}
                        className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white"
                      />
                    </label>
                  </div>

                  <label className="mt-4 inline-flex items-center gap-2 text-sm text-zinc-200">
                    <input
                      type="checkbox"
                      checked={resizeState.lockAspect}
                      onChange={(event) => setResizeState((prev) => (prev ? { ...prev, lockAspect: event.target.checked } : prev))}
                      className="h-4 w-4 accent-cyan-400"
                    />
                    Lock Aspect Ratio
                  </label>
                  {!resizeState.lockAspect && (
                    <p className="mt-2 text-xs text-amber-300">Aspect ratio unlocked. Independent width and height can distort the image.</p>
                  )}

                  <div className="mt-4 grid grid-cols-4 gap-2 text-xs">
                    {[
                      { key: "25", label: "25%" },
                      { key: "50", label: "50%" },
                      { key: "75", label: "75%" },
                      { key: "100", label: "100%" },
                      { key: "150", label: "150%" },
                      { key: "200", label: "200%" },
                      { key: "original", label: "Original" },
                      { key: "custom", label: "Custom" },
                    ].map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        onClick={() =>
                          setResizePreset(
                            preset.key as "25" | "50" | "75" | "100" | "150" | "200" | "original" | "custom",
                          )
                        }
                        className="rounded-lg border border-white/20 px-2 py-1.5 text-zinc-200 hover:border-cyan-300"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  {warningUpscale && (
                    <p className="mt-3 text-xs text-amber-300">
                      This image is being enlarged beyond its original resolution and may appear softer.
                    </p>
                  )}

                  <div className="mt-5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={applyResizeModal}
                      className="rounded-lg border border-cyan-300/60 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-100 hover:border-cyan-200"
                    >
                      Apply Resize
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setResizeState((prev) =>
                          prev
                            ? {
                                ...prev,
                                width: target.originalWidth,
                                height: target.originalHeight,
                              }
                            : prev,
                        )
                      }
                      className="rounded-lg border border-white/20 px-4 py-2 text-sm text-zinc-200 hover:border-violet-300"
                    >
                      Reset to Original Size
                    </button>
                    <button
                      type="button"
                      onClick={() => setResizeState(null)}
                      className="rounded-lg border border-white/20 px-4 py-2 text-sm text-zinc-200 hover:border-red-300"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {result && resultViewer.fullscreen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/95 p-4" onClick={() => setResultViewer((prev) => ({ ...prev, fullscreen: false }))}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-xl font-semibold">Fullscreen Result Preview</h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setResultViewer((prev) => ({ ...prev, zoom: Math.min(8, prev.zoom + 0.2), fit: false }))}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
              >
                Zoom In
              </button>
              <button
                type="button"
                onClick={() => setResultViewer((prev) => ({ ...prev, zoom: Math.max(0.1, prev.zoom - 0.2), fit: false }))}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
              >
                Zoom Out
              </button>
              <button
                type="button"
                onClick={() => setResultViewer((prev) => ({ ...prev, fit: true, zoom: 1 }))}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
              >
                Fit Screen
              </button>
              <button
                type="button"
                onClick={() => setResultViewer((prev) => ({ ...prev, fit: false, zoom: 1 }))}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-cyan-300"
              >
                Actual Size
              </button>
              <button
                type="button"
                onClick={() => setResultViewer((prev) => ({ ...prev, fit: false, zoom: 1 }))}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-violet-300"
              >
                Reset Zoom
              </button>
              <button
                type="button"
                onClick={() => setResultViewer((prev) => ({ ...prev, fullscreen: false }))}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:border-red-300"
              >
                Close
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-white/10 bg-black/60 p-3" onClick={(event) => event.stopPropagation()}>
            <img
              src={result.url}
              alt="Merged output fullscreen preview"
              className={resultViewer.fit ? "mx-auto max-h-full max-w-full object-contain" : "h-auto w-auto"}
              style={resultViewer.fit ? undefined : { maxWidth: "none", transform: `scale(${resultViewer.zoom})`, transformOrigin: "top left" }}
            />
          </div>
        </div>
      )}

      <div className="fixed right-3 top-3 z-[60] flex w-[min(26rem,92vw)] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-xl ${
              toast.kind === "error"
                ? "border-red-300/50 bg-red-500/15 text-red-100"
                : toast.kind === "success"
                  ? "border-emerald-300/50 bg-emerald-500/15 text-emerald-100"
                  : "border-cyan-300/40 bg-cyan-500/15 text-cyan-100"
            }`}
            role="status"
            aria-live="polite"
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
