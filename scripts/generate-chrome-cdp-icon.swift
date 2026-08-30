import AppKit
import Foundation

guard CommandLine.arguments.count >= 3 else {
    fputs("usage: generate-chrome-cdp-icon.swift <chrome-icns> <out-png>\n", stderr)
    exit(1)
}

let chromePath = CommandLine.arguments[1]
let outPath = CommandLine.arguments[2]
let size: CGFloat = 1024

guard let chrome = NSImage(contentsOfFile: chromePath) else {
    fputs("failed to load chrome icon: \(chromePath)\n", stderr)
    exit(2)
}

let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
chrome.draw(in: NSRect(x: 0, y: 0, width: size, height: size))

let badgeHeight = size * 0.30
let badgeRect = NSRect(x: 0, y: 0, width: size, height: badgeHeight)
NSColor(calibratedRed: 0.90, green: 0.33, blue: 0.08, alpha: 1.0).setFill()
badgeRect.fill()

let text = "CDP" as NSString
let fontSize = badgeHeight * 0.52
let font = NSFont.boldSystemFont(ofSize: fontSize)
let attrs: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: NSColor.white,
]
let textSize = text.size(withAttributes: attrs)
let point = NSPoint(x: (size - textSize.width) / 2, y: (badgeHeight - textSize.height) / 2)
text.draw(at: point, withAttributes: attrs)

image.unlockFocus()

guard
    let tiff = image.tiffRepresentation,
    let rep = NSBitmapImageRep(data: tiff),
    let png = rep.representation(using: .png, properties: [:])
else {
    fputs("failed to encode png\n", stderr)
    exit(3)
}

do {
    try png.write(to: URL(fileURLWithPath: outPath))
} catch {
    fputs("failed to write png: \(error)\n", stderr)
    exit(4)
}
