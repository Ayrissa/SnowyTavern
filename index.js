import { createSnowEngine } from './snow-engine.js';

const MODULE_NAME = 'SnowyTavern';
const EXT_FOLDER = 'third-party/SnowyTavern';

const context = SillyTavern.getContext();
const { extensionSettings, saveSettingsDebounced } = context;

const defaultSettings = {
    enabled: true,
    festiveTheme: false,
    intensity: 0.5,
};

function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    // backfill any missing keys after updates
    for (const key of Object.keys(defaultSettings)) {
        if (extensionSettings[MODULE_NAME][key] === undefined) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

let engine = null;

function applySnowState(settings) {
    if (settings.enabled) {
        if (!engine) {
            engine = createSnowEngine({ intensity: settings.intensity });
        }
        engine.start();
        engine.setIntensity(settings.intensity);
    } else if (engine) {
        engine.stop();
        engine = null;
    }
}

function applyFestiveTheme(settings) {
    document.body.classList.toggle('snowytavern-festive', !!settings.festiveTheme);
}

async function loadSettingsHtml() {
    const response = await fetch(`/scripts/extensions/${EXT_FOLDER}/settings.html`);
    return await response.text();
}

function bindSettingsUi(settings) {
    const $enabled = $('#snowytavern_enabled');
    const $festive = $('#snowytavern_festive');
    const $intensity = $('#snowytavern_intensity');
    const $intensityValue = $('#snowytavern_intensity_value');
    const $clearButton = $('#snowytavern_clear');

    $enabled.prop('checked', settings.enabled);
    $festive.prop('checked', settings.festiveTheme);
    $intensity.val(Math.round(settings.intensity * 100));
    $intensityValue.text(`${Math.round(settings.intensity * 100)}%`);

    $enabled.on('change', function () {
        settings.enabled = !!$(this).prop('checked');
        applySnowState(settings);
        saveSettingsDebounced();
    });

    $festive.on('change', function () {
        settings.festiveTheme = !!$(this).prop('checked');
        applyFestiveTheme(settings);
        saveSettingsDebounced();
    });

    $intensity.on('input', function () {
        const value = Number($(this).val()) / 100;
        settings.intensity = value;
        $intensityValue.text(`${Math.round(value * 100)}%`);
        if (engine) engine.setIntensity(value);
        saveSettingsDebounced();
    });

    $clearButton.on('click', function () {
        if (engine) engine.clearSnow();
    });
}

jQuery(async () => {
    const settings = getSettings();

    try {
        const settingsHtml = await loadSettingsHtml();
        $('#extensions_settings2').append(settingsHtml);
        bindSettingsUi(settings);
    } catch (err) {
        console.error('[SnowyTavern] Failed to load settings UI:', err);
    }

    applyFestiveTheme(settings);
    applySnowState(settings);
});
