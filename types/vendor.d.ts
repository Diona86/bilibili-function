interface Window { mpdParser: { parse(xml: string, options: {manifestUri: string}): any; stringToMpdXml(xml: string): Element } }
interface PerformanceResourceTiming { readonly contentType?: string }
interface HTMLMediaElement { readonly controlsList?: DOMTokenList }
