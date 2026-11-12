'use strict';

// PPSSPP's defaults for the settings the app reports (CfgFlag::REPORT in Core/Config.cpp), keyed the way they're stored:
// section + ini key, values as the app sends them (bools "true"/"false", ints as numbers).  Only used to show which settings
// a report changed; ingest still stores what it always did (see lookups.js defaultConfig).
// Source: hrydgard/ppsspp master 43c60ee651 (2026-11-12) plus settings only v1.20.x still reports.  When the app adds a
// reported setting, add it here; until then it's listed as "no known default" and not counted as changed.
const FIXED = {
	GeneralEnableCheats: 'false',
	GeneralEnablePlugins: 'true',
	GeneralDisableHLEFlags: '0',
	GeneralForceEnableHLEFlags: '0',
	GeneralMemStickInserted: 'true',
	GeneralIgnoreCompatSettings: '',
	CPUIOTimingMethod: '0',            // IOTIMING_FAST
	CPUEmulateMediaEngine: 'true',
	CPUFunctionReplacements: 'true',
	CPUCPUSpeed: '0',
	GraphicsSkipBufferEffects: 'false',
	GraphicsHardwareTransform: 'true',      // v1.20 name
	GraphicsHardwareTransformDebug: 'true', // master name
	GraphicsTextureFiltering: '1',          // auto
	GraphicsSmart2DTexFiltering: 'false',
	GraphicsHighQualityDepth: ['true', '1'],
	GraphicsFrameSkip: '0',
	GraphicsReplaceTextures: 'true',
	GraphicsSaveNewTextures: 'false',
	GraphicsTexScalingLevel: '1',
	GraphicsTexScalingType: '0',
	GraphicsTexDeposterize: 'false',
	GraphicsTexHardwareScaling: 'false',
	GraphicsBloomHack: '0',
	GraphicsSkipGPUReadbackMode: '0',
	GraphicsLimitFrameRateTo30: '0',        // FrameRateLimit30::AUTO
	SystemParamPSPModel: '1',               // PSP_MODEL_SLIM
	SystemParamPSPFirmwareVersion: '660',
	SystemParamGameLanguage: '-1',          // auto
	SystemParamButtonPreference: '1',       // cross
	SystemParamEncryptSave: 'true',
	JITDiscardRegsOnJRRA: 'false',
	// Only reported by v1.20.x (removed or renamed since).
	GraphicsDisableRangeCulling: 'false',
	GraphicsSoftwareSkinning: 'true',
	GraphicsTextureBackoffCache: 'false',
	GraphicsSplineBezierQuality: '2',
	GraphicsHardwareTessellation: 'false',
};

// Defaults that depend on the device or platform: every value listed can be a default somewhere, so only other values
// count as changed.
const DEVICE = {
	CPUCPUCore: ['1', '2'],                     // JIT, or the IR interpreter where JIT isn't allowed (iOS etc.)
	CPUSeparateSASThread: ['true', 'false'],    // more than one core
	GraphicsGraphicsBackend: ['0', '2', '3', '4'], // OpenGL / D3D11 / Vulkan / Metal (iOS, master) by platform and OS version
	GraphicsDepthRasterMode: ['0', '1', '2'],   // default / low quality (mobile) / off (no SIMD)
	GraphicsInternalResolution: ['0', '1', '2', '4'], // auto on desktop, 1x/2x by screen size, 2x iOS, 4x VR
	GraphicsAutoFrameSkip: ['false', 'true'],   // on in VR
	GraphicsVertexDecJit: ['true', 'false'],    // false on CPUs without a code generator
};

// Splits a report's settings into changed / device-dependent (value can be a default) / at default / unknown.
function classify(settings)
{
	const out = { changed: {}, device: {}, unchanged: {}, unknown: {} };
	for (const key of Object.keys(settings).sort())
	{
		const v = String(settings[key]);
		if (key in FIXED)
		{
			const def = [].concat(FIXED[key]);
			if (def.includes(v))
				out.unchanged[key] = v;
			else
				out.changed[key] = { value: v, default: def[0] };
		}
		else if (key in DEVICE)
		{
			if (DEVICE[key].includes(v))
				out.device[key] = v;
			else
				out.changed[key] = { value: v, default: DEVICE[key].join(' or ') };
		}
		else
			out.unknown[key] = v;
	}
	return out;
}

module.exports = { FIXED, DEVICE, classify };
