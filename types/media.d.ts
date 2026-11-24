export type DownloadState = "Pending" | "Detecting" | "Downloading" | "Merging" | "Verifying" | "Completed" | "Failed" | "Cancelled";
export interface MediaTrack {
  id: string;
  url?: string;
  label?: string;
  language?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  codecs?: string;
  segmentCount?: number;
  default?: boolean;
  unsupportedReason?: string;
}
export interface MediaResource {
  id: string;
  tabId: number;
  documentId: string | null;
  pageUrl: string;
  pageTitle: string;
  frameUrl: string;
  mediaUrl: string | null;
  title: string;
  mediaType: string;
  sourceType: string;
  protocol: "direct" | "hls" | "dash" | "bilibili" | "player" | "frame";
  mimeType: string | null;
  fileExtension: string | null;
  contentLength: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  resolution: string | null;
  bitrate: number | null;
  frameRate: number | null;
  codecs: string | null;
  audioTracks: MediaTrack[];
  videoTracks: MediaTrack[];
  subtitleTracks: MediaTrack[];
  detectedAt: number;
  lastSeenAt: number;
  detectionConfidence: string;
  downloadStatus: DownloadState | null;
  supportStatus: "detected" | "ready" | "unsupported" | "permission";
  unsupportedReason: string | null;
  alternatives?: Partial<MediaResource>[];
  segmentsSeen?: string[];
  resourceKey?: string;
}
