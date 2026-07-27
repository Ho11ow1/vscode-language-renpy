// Completion Provider
import {
    CancellationToken,
    CompletionContext,
    CompletionItem,
    CompletionItemKind,
    CompletionTriggerKind,
    languages,
    LogLevel,
    Position,
    ProviderResult,
    TextDocument,
    workspace,
} from "vscode";

import { Displayable } from "./displayable";
import { getDefinitionFromFile } from "./hover";
import { LogCategory, logCatMessage } from "./logger";
import { getCurrentContext } from "./navigation";
import { getDefaultStoreVariables, Namespaces, NavigationData } from "./navigation-data";

export function registerCompletionProvider() {
    return languages.registerCompletionItemProvider(
        "renpy",
        {
            provideCompletionItems(
                document: TextDocument,
                position: Position,
                token: CancellationToken,
                context: CompletionContext
            ): ProviderResult<CompletionItem[]> {
                if (token.isCancellationRequested) {
                    return;
                }

                return new Promise((resolve) => {
                    resolve(getCompletionList(document, position, context));
                });
            },
        },
        ".",
        " ",
        "@",
        "-",
        "("
    );
}

/**
 * Returns an array of auto-complete items related to the keyword at the given document/position
 * @param document - The current TextDocument
 * @param position - The current Position
 * @param context - The current CompletionContext
 * @returns An array of CompletionItem
 */
export function getCompletionList(document: TextDocument, position: Position, context: CompletionContext): CompletionItem[] | undefined {
    if (context.triggerKind === CompletionTriggerKind.TriggerCharacter) {
        const line = document.lineAt(position).text;
        const linePrefix = line.substring(0, position.character);
        if (!NavigationData.positionIsCleanForCompletion(line, position)) {
            return;
        }

        // Immediate intellisense
        if (linePrefix.trim().startsWith("$")) {
            // If user typed '$ ' or '$ myVar', get the default store variables
            const defaultVars = getDefaultStoreVariables();

            // If there is a dot after '$', e.g., '$ myVar.' or '$ store.', let standard logic handle it
            const lastWord = linePrefix.trim().split(/\s+/).pop() || "";
            if (!lastWord.includes(".")) {
                return defaultVars;
            }
        }
        // Anything specific which we already have static knowledge of
        if (linePrefix.endsWith("renpy.")) {
            return NavigationData.renpyAutoComplete;
        } else if (linePrefix.endsWith("config.")) {
            return NavigationData.configAutoComplete;
        } else if (linePrefix.endsWith("gui.")) {
            return NavigationData.guiAutoComplete;
        } else if (linePrefix.endsWith("renpy.music.")) {
            return getAutoCompleteList("renpy.music.");
        } else if (linePrefix.endsWith("renpy.audio.")) {
            return getAutoCompleteList("renpy.audio.");
            // More in depth global level namespaces
        } else if (Namespaces.some((ns) => linePrefix.endsWith(ns.name))) {
            // Specific case for direct namespaces # There's probably a better way but this is what works
            const prefixPosition = new Position(position.line, position.character - 1);
            const range = document.getWordRangeAtPosition(prefixPosition);
            const parentContext = getCurrentContext(document, position);
            if (range) {
                const parentPosition = new Position(position.line, line.length - line.trimStart().length);
                const parent = document.getText(document.getWordRangeAtPosition(parentPosition));
                const kwPrefix = document.getText(range);
                return getAutoCompleteList(kwPrefix, parent, parentContext);
            }
        }
        // This part will have to handle:
        // - rentale. lookup (i.e. rentale.(Show immediate rentale callables & variables + classes found under rentale.))
        // - Character.field lookup (i.e. Jessica.(Show Jessica callables, fields(class level and self)))
        // - Class. lookup (i.e. Discord.(Show Discord callables, fields(Class level and self)))
        // Fallback for custom lookups (stores, characters, classes, Python types, and context triggers)
        else {
            const prefixPosition = new Position(position.line, position.character - 1);
            const range = document.getWordRangeAtPosition(prefixPosition);
            const parentContext = getCurrentContext(document, position);

            if (range) {
                const parentPosition = new Position(position.line, line.length - line.trimStart().length);
                const parent = document.getText(document.getWordRangeAtPosition(parentPosition));
                const kwPrefix = document.getText(range);

                logCatMessage(
                    LogLevel.Info,
                    LogCategory.Default,
                    `[getCompletionList] line: "${line}" | kwPrefix: "${kwPrefix}" | parent: "${parent}"`
                );

                return getAutoCompleteList(kwPrefix, parent, parentContext);
            } else if (
                context.triggerCharacter === "-" ||
                context.triggerCharacter === "@" ||
                context.triggerCharacter === "=" ||
                context.triggerCharacter === " "
            ) {
                const parentPosition = new Position(position.line, line.length - line.trimStart().length);
                const parent = document.getText(document.getWordRangeAtPosition(parentPosition));
                if (parent) {
                    if (context.triggerCharacter === "=") {
                        return getAutoCompleteList(parent);
                    } else {
                        return getAutoCompleteList(context.triggerCharacter, parent, parentContext);
                    }
                }
            }
        }
    }
    return undefined;
}

/**
 * Returns a list of CompletionItem objects for the previous keyword/statement before the current position
 * @param prefix - The previous keyword/statement
 * @param parent - The parent statement
 * @param context - The context of this keyword
 * @returns A list of CompletionItem objects
 */
export function getAutoCompleteList(prefix: string, parent = "", context = ""): CompletionItem[] | undefined {
    logCatMessage(LogLevel.Info, LogCategory.Default, `[getAutoCompleteList IN] prefix: "${prefix}" | parent: "${parent}" | context: "${context}"`);

    const newList: CompletionItem[] = [];
    const channels = getAudioChannels();
    const characters = Object.keys(NavigationData.gameObjects["characters"]);

    // Extract potential variable name (strip leading '$', trailing dots, or sub-properties)
    const checkTarget = prefix.includes(".") ? prefix.split(".")[0] : prefix;
    const cleanVar = checkTarget.replace(/^\$\s*/, "").trim();

    // Defined Python Variable Instances (i.e., $ II_Wine_Red. or $ E_City_Unlock_All.)
    // Only intercepts if cleanVar actually exists as a variable in define_types
    const defType = NavigationData.gameObjects["define_types"]?.[cleanVar];
    if (defType && defType.type) {
        let targetType = defType.type || defType.baseClass || "";
        targetType = targetType.split("(")[0].trim(); // Clean off constructor params

        logCatMessage(LogLevel.Info, LogCategory.Default, `[getAutoCompleteList] Variable match: '${cleanVar}' -> type: '${targetType}'`);

        const normalized = normalizeTypeName(targetType);

        // Standard Python built-ins (str, list, dict, int, bool)
        if (PYTHON_BUILTIN_METHODS[normalized]) {
            return getBuiltinPythonMethods(normalized);
        }

        // Custom Class Instances (e.g., "rentale.InventoryItem", "rentale.Event")
        if (targetType) {
            const classMembers = getClassMemberCompletions(targetType);
            if (classMembers.length > 0) {
                return classMembers;
            }
        }
    }

    // Audio and Music namespaces
    if (prefix === "renpy.music." || prefix === "renpy.audio.") {
        const cleanPrefix = prefix.replace("renpy.", "").trim();
        const list = NavigationData.renpyAutoComplete.filter((item) => {
            if (typeof item.label === "string") {
                return item.label.startsWith(cleanPrefix);
            }
            return false;
        });
        for (const item of list) {
            if (typeof item.label === "string") {
                newList.push(new CompletionItem(item.label.replace(cleanPrefix, ""), item.kind));
            }
        }
        return newList;
    }

    // Persistent store variables
    else if (prefix === "persistent") {
        const directObjects = NavigationData.data.location["persistent"];
        for (const key in directObjects) {
            newList.push(new CompletionItem(key, CompletionItemKind.Value));
        }
        // Shouldn't have to do this but going through callables just fails so this it is
        newList.push(new CompletionItem("_clear", CompletionItemKind.Method));
        newList.push(new CompletionItem("_hasattr", CompletionItemKind.Method));

        return newList;
    }

    // Ren'Py default store variables
    else if (prefix === "store") {
        return getDefaultStoreVariables();
    }

    // Custom sub-stores / modules (e.g. $ rentale. or store.rentale.)
    else if (isNamedStore(prefix) || isNamedStore(cleanVar)) {
        const storeTarget = isNamedStore(prefix) ? prefix : cleanVar;
        logCatMessage(LogLevel.Info, LogCategory.Default, `[getAutoCompleteList] Store match for: '${storeTarget}'`);
        return getNamedStoreAutoComplete(storeTarget);
    }

    // Audio channels (e.g., play music ..., stop sound)
    else if (channels.includes(prefix)) {
        if (parent && parent === "stop") {
            newList.push(new CompletionItem("fadeout", CompletionItemKind.Keyword));
        } else {
            const category = NavigationData.data.location["define"];
            const audio = Object.keys(category).filter((key) => key.startsWith("audio."));
            for (const key of audio) {
                newList.push(new CompletionItem(key.substring(6), CompletionItemKind.Variable));
            }
        }
        return newList;
    }

    // Direct Class references (e.g., MyClass.)
    else if (NavigationData.isClass(prefix)) {
        const className = NavigationData.isClass(prefix);
        if (className) {
            const classMembers = getClassMemberCompletions(className);
            return classMembers.length > 0 ? classMembers : NavigationData.getClassAutoComplete(className);
        }
    }

    // Callable containers (Ren'Py internal modules/functions)
    else if (isCallableContainer(prefix)) {
        return getCallableAutoComplete(prefix);
    }

    // Internal Ren'Py classes
    else if (isInternalClass(prefix)) {
        return getInternalClassAutoComplete(prefix);
    }

    // Character attributes in dialogue/label statements
    else if (context === "label" && characters.includes(parent)) {
        const category = NavigationData.gameObjects["attributes"][parent];
        if (category) {
            for (const key of category) {
                newList.push(new CompletionItem(key, CompletionItemKind.Value));
            }
        }
        return newList;
    }

    // General keyword auto-complete fallback
    else {
        return getAutoCompleteKeywords(prefix, parent, context);
    }

    return newList;
}

/**
 * Returns a list of CompletionItem objects for the given keyword
 * @param keyword - The keyword to search
 * @param parent - The keyword's parent keyword
 * @param context - The context of the keyword
 * @returns A list of CompletionItem objects
 */
export function getAutoCompleteKeywords(keyword: string, parent: string, context: string): CompletionItem[] {
    let newList: CompletionItem[] = [];
    let enumerations;
    if (context) {
        enumerations = NavigationData.autoCompleteKeywords[`${context}.${keyword}`];
    }
    if (!enumerations) {
        enumerations = NavigationData.autoCompleteKeywords[keyword];
    }

    if (enumerations) {
        const split = enumerations.split("|");
        for (const index in split) {
            if (split[index].startsWith("{")) {
                let gameDataKey = split[index].replace("{", "").replace("}", "");
                let quoted = false;
                let args = 0;
                if (gameDataKey.indexOf("!") > 0) {
                    const split2 = gameDataKey.split("!");
                    gameDataKey = split2[0];
                    quoted = split2[1] === "q";
                    if (isNormalInteger(split2[1])) {
                        args = Math.floor(Number(split2[1]));
                    }
                }

                if (gameDataKey === "action") {
                    // get list of screen Actions
                    const category = NavigationData.renpyFunctions.internal;
                    const transitions = Object.keys(category).filter((key) => category[key][4] === "Action");
                    if (transitions) {
                        for (const key of transitions) {
                            const detail = category[key][2];
                            newList.push(new CompletionItem({ label: key, detail: detail }, CompletionItemKind.Value));
                        }
                    }
                    continue;
                } else if (gameDataKey === "function") {
                    // get list of callable functions
                    const callables = NavigationData.data.location["callable"];
                    if (callables) {
                        const filtered = Object.keys(callables).filter((key) => key.indexOf(".") === -1);
                        for (const key of filtered) {
                            const callable = callables[key];
                            const navigation = getDefinitionFromFile(callable[0], callable[1]);
                            let detail = "";
                            if (navigation) {
                                detail = navigation.args;
                                if (args > 0) {
                                    if (navigation.args.split(",").length !== args) {
                                        continue;
                                    }
                                }
                            }
                            newList.push(new CompletionItem({ label: key, detail: detail }, CompletionItemKind.Function));
                        }
                    }
                } else if (gameDataKey === "layer") {
                    const layers = getLayerConfiguration(quoted);
                    if (layers) {
                        for (const key of layers) {
                            newList.push(key);
                        }
                    }
                    continue;
                } else if (gameDataKey === "screens") {
                    // get list of screens
                    const category = NavigationData.data.location["screen"];
                    for (let key in category) {
                        if (quoted) {
                            key = '"' + key + '"';
                        }
                        newList.push(new CompletionItem(key, CompletionItemKind.Variable));
                    }
                    return newList;
                } else if (gameDataKey === "label") {
                    newList.push(new CompletionItem("expression", CompletionItemKind.Keyword));
                    const category = NavigationData.data.location["label"];
                    for (let key in category) {
                        if (quoted) {
                            key = '"' + key + '"';
                        }
                        newList.push(new CompletionItem(key, CompletionItemKind.Value));
                    }
                    return newList;
                } else if (gameDataKey === "outlines") {
                    let gameObjects = [];
                    if (NavigationData.data.location[gameDataKey]) {
                        gameObjects = NavigationData.data.location[gameDataKey]["array"] || [];
                        if (gameObjects) {
                            for (const key of gameObjects) {
                                const ci = new CompletionItem(key, CompletionItemKind.Value);
                                ci.sortText = "1" + key;
                                newList.push(ci);
                            }
                        } else {
                            gameObjects = [];
                        }
                    }

                    if (!gameObjects.includes('[(1, "#000000", 0, 0)]')) {
                        newList.push(new CompletionItem('[(1, "#000000", 0, 0)]', CompletionItemKind.Value));
                    }
                    if (!gameObjects.includes('[(1, "#000000", 1, 1)]')) {
                        newList.push(new CompletionItem('[(1, "#000000", 1, 1)]', CompletionItemKind.Value));
                    }
                    newList.push(new CompletionItem('[(absolute(1), "#000000", absolute(1), absolute(1))]', CompletionItemKind.Value));
                    newList.push(new CompletionItem("[(size, color, xoffset, yoffset)]", CompletionItemKind.Value));
                    continue;
                } else if (gameDataKey === "displayable") {
                    const display = getDisplayableAutoComplete(quoted);
                    if (display) {
                        for (const ci of display) {
                            newList.push(ci);
                        }
                    }
                    continue;
                } else if (gameDataKey === "audio") {
                    // get defined audio variables
                    const category = NavigationData.data.location["define"];
                    const audio = Object.keys(category).filter((key) => key.startsWith("audio."));
                    for (const key of audio) {
                        const ci = new CompletionItem(key, CompletionItemKind.Variable);
                        ci.sortText = "0" + key;
                        newList.push(ci);
                    }
                    // get auto detected audio variables
                    const gameObjects = NavigationData.gameObjects["audio"];
                    if (gameObjects) {
                        for (const key in gameObjects) {
                            if (!newList.some((e) => e.label === key)) {
                                const obj = gameObjects[key];
                                let ci: CompletionItem;
                                if (obj.startsWith('"')) {
                                    ci = new CompletionItem(gameObjects[key], CompletionItemKind.Folder);
                                    ci.sortText = "2" + key;
                                } else {
                                    ci = new CompletionItem(gameObjects[key], CompletionItemKind.Value);
                                    ci.sortText = "1" + key;
                                }
                                newList.push(ci);
                            }
                        }
                    }
                    continue;
                } else if (gameDataKey === "transforms") {
                    // get the Renpy default Transforms
                    const internal = NavigationData.renpyFunctions.internal;
                    const transforms = Object.keys(internal).filter((key) => internal[key][0] === "transforms");
                    for (const key of transforms) {
                        const detail = internal[key][2];
                        newList.push(new CompletionItem({ label: key, detail: detail }, CompletionItemKind.Value));
                    }
                    // get list of defined Transforms
                    const category = NavigationData.data.location["transform"];
                    for (const key in category) {
                        const defType = NavigationData.gameObjects["define_types"][key];
                        if (defType) {
                            newList.push(new CompletionItem(key, CompletionItemKind.Value));
                        }
                    }

                    continue;
                } else if (gameDataKey === "transitions") {
                    // get list of Transitions
                    const category = NavigationData.renpyFunctions.internal;
                    newList.push(new CompletionItem("None", CompletionItemKind.Value));
                    // get the Renpy default transitions and Transition classes
                    const transitions = Object.keys(category).filter((key) => category[key][0] === "transitions");
                    for (const key of transitions) {
                        const detail = category[key][2];
                        newList.push(new CompletionItem({ label: key, detail: detail }, CompletionItemKind.Value));
                    }
                    // get the user define transitions
                    const defines = NavigationData.gameObjects["define_types"];
                    const defTransitions = Object.keys(defines).filter((key) => defines[key].type === "transitions");
                    for (const key of defTransitions) {
                        newList.push(new CompletionItem(key, CompletionItemKind.Value));
                    }
                    continue;
                }

                const gameObjects = NavigationData.gameObjects[gameDataKey];
                if (gameObjects) {
                    for (let key in gameObjects) {
                        if (quoted) {
                            key = '"' + key + '"';
                        }
                        const ci = new CompletionItem(key, CompletionItemKind.Value);
                        ci.sortText = quoted ? "2" + key : "1" + key;
                        newList.push(ci);
                    }
                } else {
                    const navObjects = NavigationData.data.location[gameDataKey];
                    if (navObjects) {
                        for (let key in navObjects) {
                            if (quoted) {
                                key = '"' + key + '"';
                            }
                            const ci = new CompletionItem(key, CompletionItemKind.Value);
                            ci.sortText = quoted ? "2" + key : "1" + key;
                            newList.push(ci);
                        }
                    }
                }
            } else {
                let ci = new CompletionItem(split[index], CompletionItemKind.Constant);
                if (split[index].indexOf("(") > 0) {
                    const key = split[index].substring(0, split[index].indexOf("("));
                    const detail = split[index].substring(split[index].indexOf("("));
                    ci = new CompletionItem({ label: key, detail: detail }, CompletionItemKind.Method);
                }
                ci.sortText = "0" + split[index];
                newList.push(ci);
            }
        }
    }

    if (newList.length === 0 && parent.length > 0) {
        newList = getAutoCompleteKeywords(`parent.${context}.${parent}`, "", "");
        if (newList.length > 0) {
            return newList;
        }
        return getAutoCompleteKeywords(`parent.${parent}`, "", "");
    }

    return newList;
}

/**
 * Determines if the given string is a normal integer number
 * @param str - The string containing a numeric value
 * @returns - True if the given string is a normal integer number
 */
function isNormalInteger(str: string) {
    const n = Math.floor(Number(str));
    return n !== Infinity && String(n) === str && n >= 0;
}

/**
 * Returns a list of the audio channels, both system and user-defined
 * @returns An array of strings containing the names of the available audio channels
 */
function getAudioChannels(): string[] {
    const newList: string[] = [];
    const enumerations = NavigationData.autoCompleteKeywords["play"];
    if (enumerations) {
        const split = enumerations.split("|");
        for (const index in split) {
            if (split[index].startsWith("{")) {
                const gameDataKey = split[index].replace("{", "").replace("}", "");
                const gameObjects = NavigationData.gameObjects[gameDataKey];
                for (const key in gameObjects) {
                    newList.push(key);
                }
            } else {
                newList.push(split[index]);
            }
        }
    }
    return newList;
}

/**
 * Returns an array containing the `config.layer` definitions
 * @remarks
 * This method looks for a user configured `define config.layers` definition, or else it returns the default config.layers definition
 *
 * @returns The config.layer configuration as string[] (e.g, `[ 'master', 'transient', 'screens', 'overlay']`)
 */
function getLayerConfiguration(quoted = false): CompletionItem[] | undefined {
    const newList: CompletionItem[] = [];
    const layers = NavigationData.find("config.layers");
    if (layers) {
        for (const layer of layers) {
            if (layer.args) {
                const args = layer.args.replace(/ /g, "").replace(/'/g, '"').replace("=", "").trim();
                const defaultLayers = JSON.parse(args);
                if (defaultLayers) {
                    for (let l of defaultLayers) {
                        if (quoted) {
                            l = '"' + l + '"';
                        }
                        newList.push(new CompletionItem(l, CompletionItemKind.Variable));
                    }
                    return newList;
                }
            } else {
                const docs = getDefinitionFromFile(layer.filename, layer.location);
                const args = docs?.keyword.replace(/ /g, "").replace(/'/g, '"').replace("defineconfig.layers=", "");
                if (args) {
                    const userLayers = JSON.parse(args);
                    for (let l of userLayers) {
                        if (quoted) {
                            l = '"' + l + '"';
                        }
                        newList.push(new CompletionItem(l, CompletionItemKind.Variable));
                    }
                    return newList;
                }
            }
        }
    }
    return;
}

function getDisplayableAutoComplete(quoted = false): CompletionItem[] {
    if (
        NavigationData.displayableAutoComplete == null ||
        NavigationData.displayableAutoComplete.length === 0 ||
        NavigationData.displayableQuotedAutoComplete == null ||
        NavigationData.displayableQuotedAutoComplete.length === 0
    ) {
        NavigationData.displayableAutoComplete = [];
        NavigationData.displayableQuotedAutoComplete = [];

        const config = workspace.getConfiguration("renpy");
        let showAutoImages = true;
        if (config && !config.showAutomaticImagesInCompletion) {
            showAutoImages = false;
        }
        const category = NavigationData.data.location["displayable"];
        for (const key in category) {
            const display: Displayable = category[key];
            if (display.location < 0 && showAutoImages) {
                let ci = new CompletionItem(key, CompletionItemKind.Folder);
                ci.sortText = "1" + key;
                NavigationData.displayableAutoComplete.push(ci);

                ci = new CompletionItem('"' + key + '"', CompletionItemKind.Folder);
                ci.sortText = "1" + key;
                NavigationData.displayableQuotedAutoComplete.push(ci);
            } else if (display.location >= 0) {
                let ci = new CompletionItem(key, CompletionItemKind.Value);
                ci.sortText = "0" + key;
                NavigationData.displayableAutoComplete.push(ci);

                ci = new CompletionItem('"' + key + '"', CompletionItemKind.Value);
                ci.sortText = "0" + key;
                NavigationData.displayableQuotedAutoComplete.push(ci);
            }
        }

        if (!NavigationData.displayableAutoComplete.some((e) => e.label === "black")) {
            const black = new CompletionItem("black", CompletionItemKind.Value);
            black.sortText = "0black";
            NavigationData.displayableAutoComplete.push(black);
        }
        if (!NavigationData.displayableQuotedAutoComplete.some((e) => e.label === "black")) {
            const black = new CompletionItem('"black"', CompletionItemKind.Value);
            black.sortText = "0black";
            NavigationData.displayableQuotedAutoComplete.push(black);
        }
    }

    if (quoted) {
        return NavigationData.displayableQuotedAutoComplete;
    } else {
        return NavigationData.displayableAutoComplete;
    }
}

function isCallableContainer(keyword: string): boolean {
    const prefix = keyword + ".";
    const callables = NavigationData.data.location["callable"];
    if (callables) {
        return Object.keys(callables).some((key) => key.indexOf(prefix) === 0);
    }
    return false;
}

function getCallableAutoComplete(keyword: string): CompletionItem[] | undefined {
    const newlist: CompletionItem[] = [];
    const prefix = keyword + ".";

    // get the list of callables
    const callables = NavigationData.data.location["callable"];
    if (callables) {
        const filtered = Object.keys(callables).filter((key) => key.indexOf(prefix) === 0);
        if (filtered) {
            for (const key in filtered) {
                const label = filtered[key].substring(prefix.length);
                newlist.push(new CompletionItem(label, CompletionItemKind.Method));
            }
        }
    }

    return newlist;
}

function isInternalClass(keyword: string): boolean {
    const prefix = keyword + ".";
    const callables = NavigationData.renpyFunctions.internal;
    if (callables) {
        return Object.keys(callables).some((key) => key.indexOf(prefix) === 0);
    }
    return false;
}

function getInternalClassAutoComplete(keyword: string): CompletionItem[] | undefined {
    const newlist: CompletionItem[] = [];
    const prefix = keyword + ".";

    // get the list of callables
    const callables = NavigationData.renpyFunctions.internal;
    if (callables) {
        const filtered = Object.keys(callables).filter((key) => key.indexOf(prefix) === 0);
        if (filtered) {
            for (const key in filtered) {
                const label = filtered[key].substring(prefix.length);
                newlist.push(new CompletionItem(label, CompletionItemKind.Method));
            }
        }
    }

    return newlist;
}

function isNamedStore(keyword: string): boolean {
    const stores = NavigationData.gameObjects["stores"][keyword];
    if (stores) {
        return true;
    }
    return false;
}

function getNamedStoreAutoComplete(keyword: string): CompletionItem[] | undefined {
    const newList: CompletionItem[] = [];
    const addedLabels = new Set<string>();
    const dotPrefix = `${keyword}.`;

    // Collect direct variables defined in this store (i.e. default rentale.II_Wine_Red = rentale.InventoryItem()))
    const defines = NavigationData.data?.location?.["define"];
    if (defines) {
        for (const key of Object.keys(defines)) {
            const cleanKey = key.startsWith("store.") ? key.substring(6) : key;
            if (cleanKey.startsWith(dotPrefix)) {
                const varName = cleanKey.substring(dotPrefix.length);
                // Ensure we only grab direct variables, not deeper nested dots
                if (varName && !varName.includes(".") && !addedLabels.has(varName)) {
                    addedLabels.add(varName);
                    newList.push(new CompletionItem(varName, CompletionItemKind.Variable));
                }
            }
        }
    }

    const defineTypes = NavigationData.gameObjects?.["define_types"];
    if (defineTypes) {
        for (const key of Object.keys(defineTypes)) {
            const cleanKey = key.startsWith("store.") ? key.substring(6) : key;
            if (cleanKey.startsWith(dotPrefix)) {
                const varName = cleanKey.substring(dotPrefix.length);
                if (varName && !varName.includes(".") && !addedLabels.has(varName)) {
                    addedLabels.add(varName);
                    newList.push(new CompletionItem(varName, CompletionItemKind.Variable));
                }
            }
        }
    }

    // Collect callables (functions & classes) registered in location["callable"]
    const callables = NavigationData.data?.location?.["callable"];
    if (callables) {
        for (const key of Object.keys(callables)) {
            const cleanKey = key.startsWith("store.") ? key.substring(6) : key;
            if (cleanKey.startsWith(dotPrefix)) {
                const remainder = cleanKey.substring(dotPrefix.length);
                const parts = remainder.split(".");

                if (parts.length === 1) {
                    // Direct function (ie.e rentale.go_to)
                    const funcName = parts[0];
                    if (!funcName.startsWith("__") && !addedLabels.has(funcName)) {
                        addedLabels.add(funcName);
                        newList.push(new CompletionItem(funcName, CompletionItemKind.Function));
                    }
                } else if (parts.length > 1) {
                    // Method/class child (i.e. rentale.inventory.contains)
                    const className = parts[0];
                    if (!addedLabels.has(className)) {
                        addedLabels.add(className);
                        newList.push(new CompletionItem(className, CompletionItemKind.Class));
                    }
                }
            }
        }
    }

    return newList;
}

// function isPythonType(keyword: string): boolean {
//     const cleanKeyword = keyword
//         .replace(/^\$\s*/, "")
//         .split(".")[0]
//         .trim(); // Probably unnecessary but we do it because type keeps being rentale.

//     const defaults = NavigationData.gameObjects["define_types"];
//     if (defaults) {
//         const defType = defaults[cleanKeyword];
//         if (defType) {
//             return defType.type !== "";
//         }
//     }
//     return false;
// }

// Complete Built-in Python methods by data type
// Probably not the correct way but it gives something so it's ok for now
const PYTHON_BUILTIN_METHODS: Record<string, string[]> = {
    int: ["as_integer_ratio", "bit_count", "bit_length", "conjugate", "from_bytes", "to_bytes"],
    float: ["as_integer_ratio", "conjugate", "fromhex", "hex", "is_integer"],
    str: [
        "capitalize",
        "casefold",
        "center",
        "count",
        "encode",
        "endswith",
        "expandtabs",
        "find",
        "format",
        "format_map",
        "index",
        "isalnum",
        "isalpha",
        "isascii",
        "isdecimal",
        "isdigit",
        "isidentifier",
        "islower",
        "isnumeric",
        "isprintable",
        "isspace",
        "istitle",
        "isupper",
        "join",
        "ljust",
        "lower",
        "lstrip",
        "maketrans",
        "partition",
        "removeprefix",
        "removesuffix",
        "replace",
        "rfind",
        "rindex",
        "rjust",
        "rpartition",
        "rsplit",
        "rstrip",
        "split",
        "splitlines",
        "startswith",
        "strip",
        "swapcase",
        "title",
        "translate",
        "upper",
        "zfill",
    ],
    list: ["append", "clear", "copy", "count", "extend", "index", "insert", "pop", "remove", "reverse", "sort"],
    dict: ["clear", "copy", "fromkeys", "get", "items", "keys", "pop", "popitem", "setdefault", "update", "values"],
    set: [
        "add",
        "clear",
        "copy",
        "difference",
        "difference_update",
        "discard",
        "intersection",
        "intersection_update",
        "isdisjoint",
        "issubset",
        "issuperset",
        "pop",
        "remove",
        "symmetric_difference",
        "symmetric_difference_update",
        "union",
        "update",
    ],
    tuple: ["count", "index"],
    NoneType: [],
    bool: ["as_integer_ratio", "bit_count", "bit_length", "conjugate", "from_bytes", "to_bytes"],
};

function normalizeTypeName(type: string): string {
    const lower = type.toLowerCase().trim();

    if (lower === "dictionary") {
        return "dict";
    }
    if (lower === "boolean") {
        return "bool";
    }
    if (lower === "number") {
        return "int";
    } // Defaults to int methods

    return lower;
}

function getBuiltinPythonMethods(type: string): CompletionItem[] {
    const newList: CompletionItem[] = [];
    const normalizedType = normalizeTypeName(type);
    const methods = PYTHON_BUILTIN_METHODS[normalizedType];

    if (methods) {
        for (const method of methods) {
            newList.push(new CompletionItem(method, CompletionItemKind.Method));
        }
    }
    return newList;
}

export function getClassMemberCompletions(className: string): CompletionItem[] {
    const newList: CompletionItem[] = [];
    const addedLabels = new Set<string>();

    let cleanClassName = className.startsWith("store.") ? className.substring(6) : className;
    cleanClassName = cleanClassName.replace(/\(.*\)$/, "").trim();
    logCatMessage(LogLevel.Info, LogCategory.Default, `getClassMemberCompletions requested for: ${className} | Cleaned: ${cleanClassName}`);
    const dotPrefixes = [`${cleanClassName}.`, `store.${cleanClassName}.`];

    // Fetch class methods from callables (excluding dunder methods)
    const callables = NavigationData.data.location?.["callable"];
    if (callables) {
        for (const key of Object.keys(callables)) {
            for (const dotPrefix of dotPrefixes) {
                if (key.startsWith(dotPrefix)) {
                    const remainder = key.substring(dotPrefix.length);
                    const parts = remainder.split(".");

                    // Only take direct methods on the class (ignore nested inner callables)
                    if (parts.length === 1) {
                        const methodName = parts[0];
                        if (methodName && !methodName.startsWith("__") && !addedLabels.has(methodName)) {
                            addedLabels.add(methodName);
                            newList.push(new CompletionItem(methodName, CompletionItemKind.Method));
                        }
                    }
                    break;
                }
            }
        }
    }

    const shortClassName = cleanClassName.split(".").pop() || cleanClassName;
    const fieldSources = [
        NavigationData.gameObjects?.["fields"]?.[cleanClassName],
        NavigationData.gameObjects?.["fields"]?.[`store.${cleanClassName}`],
        NavigationData.gameObjects?.["fields"]?.[shortClassName],
    ];

    for (const fields of fieldSources) {
        if (fields && Array.isArray(fields)) {
            for (const field of fields) {
                const rawKw = typeof field === "string" ? field : field.keyword;
                if (rawKw) {
                    const fieldName = rawKw.split(".").pop();
                    if (fieldName && !fieldName.startsWith("__") && !addedLabels.has(fieldName)) {
                        addedLabels.add(fieldName);
                        newList.push(new CompletionItem(fieldName, CompletionItemKind.Field));
                    }
                }
            }
        }
    }

    return newList;
}
