import Foundation
import CoreGraphics
import ScreenCaptureKit

struct WindowListEntry: Codable {
	let id: String
	let name: String
	let display_id: String
	let appName: String?
	let windowTitle: String?
	let bundleId: String?
	let x: Double
	let y: Double
	let width: Double
	let height: Double
	/// Process that owns the window, so callers can skip their own windows.
	let ownerPid: Int32?
}

func normalize(_ value: String?) -> String? {
	guard let rawValue = value?.trimmingCharacters(in: .whitespacesAndNewlines), !rawValue.isEmpty else {
		return nil
	}

	return rawValue
}

let excludedBundleIds: Set<String> = [
	"com.apple.controlcenter",
	"com.apple.dock",
	"com.apple.WindowManager",
	"com.apple.wallpaper.agent",
]

let excludedWindowTitles: Set<String> = [
	"Display 1 Backstop",
	"Event Shield Window",
	"Menubar",
	"Offscreen Wallpaper Window",
	"Wallpaper-",
]

/// `--z-order` lists windows front to back, for hit-testing what is under a point,
/// instead of alphabetically for menus.
/// CGWindowList fallback for listing windows. ScreenCaptureKit requires
/// Screen Recording permission for THIS helper process, and on unsigned
/// builds macOS treats the helper as a separate identity from the app, so
/// the app's own grant does not cover it and the call above throws even
/// when the app itself has permission. CGWindowList reports on-screen
/// windows (ids, titles, owners, bounds) without Screen Recording
/// permission. Capture itself still goes through the app's own permission.
func listWindowsViaCGWindowList() -> [WindowListEntry] {
	guard let windowInfo = CGWindowListCopyWindowInfo(
		[.optionOnScreenOnly, .excludeDesktopElements],
		kCGNullWindowID
	) as? [[String: Any]] else {
		return []
	}

	var displayCount: UInt32 = 0
	var displayIDs = [CGDirectDisplayID](repeating: 0, count: 16)
	let displays: [(id: CGDirectDisplayID, frame: CGRect)]
	if CGGetActiveDisplayList(16, &displayIDs, &displayCount) == .success {
		displays = (0..<Int(displayCount)).map { index in
			let id = displayIDs[index]
			return (id: id, frame: CGDisplayBounds(id))
		}
	} else {
		displays = []
	}

	let excludedOwnerNames: Set<String> = [
		"Dock",
		"Control Center",
		"ControlCenter",
		"WindowManager",
		"Wallpaper",
	]

	var entries: [WindowListEntry] = []
	for info in windowInfo {
		guard let number = info[kCGWindowNumber as String] as? Int else { continue }
		guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
		let boundsDict = info[kCGWindowBounds as String] as? [String: Any]
		let x = (boundsDict?["X"] as? NSNumber)?.doubleValue ?? 0
		let y = (boundsDict?["Y"] as? NSNumber)?.doubleValue ?? 0
		let width = (boundsDict?["Width"] as? NSNumber)?.doubleValue ?? 0
		let height = (boundsDict?["Height"] as? NSNumber)?.doubleValue ?? 0
		guard width >= 50, height >= 50 else { continue }
		let appName = normalize(info[kCGWindowOwnerName as String] as? String)
		let windowTitle = normalize(info[kCGWindowName as String] as? String)
		guard appName != nil || windowTitle != nil else { continue }
		if let appName, excludedOwnerNames.contains(appName) { continue }
		if let windowTitle, excludedWindowTitles.contains(windowTitle) { continue }
		let ownerPid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
		let frame = CGRect(x: x, y: y, width: width, height: height)
		let matchedDisplay = displays.first(where: { display in
			display.frame.intersects(frame) || display.frame.contains(CGPoint(x: frame.midX, y: frame.midY))
		})
		let resolvedWindowTitle = windowTitle ?? appName ?? "Window"
		let resolvedName: String
		if let appName, let windowTitle {
			resolvedName = "\(appName) — \(windowTitle)"
		} else {
			resolvedName = resolvedWindowTitle
		}
		entries.append(WindowListEntry(
			id: "window:\(number):0",
			name: resolvedName,
			display_id: matchedDisplay.map { String($0.id) } ?? "",
			appName: appName,
			windowTitle: resolvedWindowTitle,
			bundleId: nil,
			x: x,
			y: y,
			width: width,
			height: height,
			ownerPid: ownerPid
		))
	}

	if listsInZOrder {
		return entries
	}
	return entries.sorted { lhs, rhs in
		let lhsApp = lhs.appName ?? lhs.name
		let rhsApp = rhs.appName ?? rhs.name
		if lhsApp != rhsApp {
			return lhsApp.localizedCaseInsensitiveCompare(rhsApp) == .orderedAscending
		}
		return (lhs.windowTitle ?? lhs.name).localizedCaseInsensitiveCompare(rhs.windowTitle ?? rhs.name) == .orderedAscending
	}
}

let listsInZOrder = CommandLine.arguments.contains("--z-order")

// Force CoreGraphics Services initialization before asking ScreenCaptureKit for
// shareable content. Without this, the helper can stall sporadically when run
// as a standalone CLI process from Electron.
let _ = CGMainDisplayID()

let group = DispatchGroup()
group.enter()

Task {
	do {
		let shareableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

		struct RawWindowEntry {
			let entry: WindowListEntry
			let hasRawTitle: Bool
			let bundleId: String?
		}

		let rawEntries = shareableContent.windows.compactMap { window -> RawWindowEntry? in
			let appName = normalize(window.owningApplication?.applicationName)
			let windowTitle = normalize(window.title)
			let bundleId = normalize(window.owningApplication?.bundleIdentifier)
			let frame = window.frame

			guard window.windowLayer == 0 else {
				return nil
			}

			guard frame.width >= 50, frame.height >= 50 else {
				return nil
			}

			guard appName != nil || windowTitle != nil else {
				return nil
			}

			if let bundleId, excludedBundleIds.contains(bundleId) {
				return nil
			}

			if let windowTitle, excludedWindowTitles.contains(windowTitle) {
				return nil
			}

			let matchedDisplay = shareableContent.displays.first(where: { display in
				display.frame.intersects(frame) || display.frame.contains(CGPoint(x: frame.midX, y: frame.midY))
			})

			let resolvedWindowTitle = windowTitle ?? appName ?? "Window"
			let resolvedName: String
			if let appName, let windowTitle {
				resolvedName = "\(appName) — \(windowTitle)"
			} else {
				resolvedName = resolvedWindowTitle
			}

			let entry = WindowListEntry(
				id: "window:\(window.windowID):0",
				name: resolvedName,
				display_id: matchedDisplay.map { String($0.displayID) } ?? "",
				appName: appName,
				windowTitle: resolvedWindowTitle,
				bundleId: bundleId,
				x: Double(frame.origin.x),
				y: Double(frame.origin.y),
				width: Double(frame.width),
				height: Double(frame.height),
				ownerPid: window.owningApplication?.processID
			)

			return RawWindowEntry(entry: entry, hasRawTitle: windowTitle != nil, bundleId: bundleId)
		}

		// For apps with multiple windows, drop auxiliary windows that lack a
		// distinct title (e.g. Arc's sidebar/tab-bar chrome). If ALL windows
		// from an app lack titles, keep them all.
		var titledCountByBundle: [String: Int] = [:]
		for raw in rawEntries {
			if let bid = raw.bundleId, raw.hasRawTitle {
				titledCountByBundle[bid, default: 0] += 1
			}
		}

		let visibleEntries = rawEntries
			.filter { raw in
				guard let bid = raw.bundleId else { return true }
				if let titled = titledCountByBundle[bid], titled > 0 {
					return raw.hasRawTitle
				}
				return true
			}
			.map { $0.entry }

		// CGWindowList reports on-screen windows front to back; ScreenCaptureKit's
		// order is unspecified.
		var frontToBackRank: [String: Int] = [:]
		if listsInZOrder {
			let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
			for (rank, info) in windowInfo.enumerated() {
				if let number = info[kCGWindowNumber as String] as? Int {
					frontToBackRank["window:\(number):0"] = rank
				}
			}
		}

		var entries = listsInZOrder
			? visibleEntries.sorted { (frontToBackRank[$0.id] ?? Int.max) < (frontToBackRank[$1.id] ?? Int.max) }
			: visibleEntries.sorted { lhs, rhs in
			let lhsApp = lhs.appName ?? lhs.name
			let rhsApp = rhs.appName ?? rhs.name
			if lhsApp != rhsApp {
				return lhsApp.localizedCaseInsensitiveCompare(rhsApp) == .orderedAscending
			}

			return (lhs.windowTitle ?? lhs.name).localizedCaseInsensitiveCompare(rhs.windowTitle ?? rhs.name) == .orderedAscending
		}

		if entries.isEmpty {
			let fallbackEntries = listWindowsViaCGWindowList()
			if !fallbackEntries.isEmpty {
				entries = fallbackEntries
			}
		}

		let encoder = JSONEncoder()
		encoder.outputFormatting = [.sortedKeys]
		let data = try encoder.encode(entries)
		FileHandle.standardOutput.write(data)
	} catch {
		// ScreenCaptureKit needs Screen Recording permission for this helper
		// process; fall back to CGWindowList (see listWindowsViaCGWindowList).
		let fallbackEntries = listWindowsViaCGWindowList()
		if fallbackEntries.isEmpty {
			fputs("Error listing windows: \(error.localizedDescription)\n", stderr)
			fflush(stderr)
			exit(1)
		}
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.sortedKeys]
		if let data = try? encoder.encode(fallbackEntries) {
			FileHandle.standardOutput.write(data)
		} else {
			fputs("Error listing windows: \(error.localizedDescription)\n", stderr)
			fflush(stderr)
			exit(1)
		}
	}

	group.leave()
}

group.wait()
