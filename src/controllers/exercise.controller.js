import mongoose from "mongoose";
import httpStatus from "http-status";
import fs from "node:fs/promises";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { isPremiumActiveUser } from "../utils/access.js";
import { toMediaUrl, toMediaUrlList } from "../utils/mediaResponse.js";
import { mergeUploadedMediaIntoBody } from "../utils/uploadedMedia.js";
import { deleteCloudinaryMediaByPublicId } from "../services/cloudinary.service.js";
import { deleteR2ObjectByKey, isR2Url, uploadMediaFileToR2, uploadMediaUrlToR2 } from "../services/r2.service.js";
import { Exercise } from "../models/exercise.model.js";
import { Program } from "../models/program.model.js";
import { UserExerciseSetting } from "../models/userExerciseSetting.model.js";
import { User } from "../models/user.model.js";
import { getPlanKeyVariants } from "../constants/subscriptionPlans.js";

const EXERCISE_STATUSES = new Set(["draft", "published", "archived"]);
const EXERCISE_IMAGE_FIELDS = ["exerciseImages", "exerciseImage", "image"];
const TARGET_MUSCLE_IMAGE_FIELDS = ["targetMuscleImages", "targetMuscleImage", "muscleImages", "muscleImage"];
const DEMO_VIDEO_FIELDS = ["demoVideos", "demoVideo", "exerciseVideo", "exerciseVideos", "video"];
const EXERCISE_IMAGE_FOLDER = "exercises/images";
const TARGET_MUSCLE_IMAGE_FOLDER = "exercises/target-muscles";
const DEMO_VIDEO_FOLDER = "exercises/videos";
const PREMIUM_PLAN_KEYS = getPlanKeyVariants("premium");

const parseMaybeJson = (value) => {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
};

const getField = (body, keys) => {
  for (const key of keys) {
    if (Object.hasOwn(body, key)) {
      return { provided: true, value: body[key] };
    }
  }

  return { provided: false, value: undefined };
};

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const normalizeUploadedFiles = (files) => {
  if (!files) return {};

  if (Array.isArray(files)) {
    return files.reduce((acc, file) => {
      const fieldName = asString(file?.fieldname);
      if (!fieldName) return acc;

      if (!acc[fieldName]) {
        acc[fieldName] = [];
      }

      acc[fieldName].push(file);
      return acc;
    }, {});
  }

  return files;
};

const getUploadedFilesByFieldNames = (files, fieldNames = []) => {
  const groupedFiles = normalizeUploadedFiles(files);
  const uploadedFiles = [];

  for (const fieldName of fieldNames) {
    const fieldFiles = groupedFiles[fieldName];
    if (Array.isArray(fieldFiles) && fieldFiles.length > 0) {
      uploadedFiles.push(...fieldFiles);
    }
  }

  return uploadedFiles;
};

const cleanupTemporaryUpload = async (file) => {
  const filePath = asString(file?.path);
  if (!filePath) return;

  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore cleanup errors for temporary upload files.
  }
};

const cleanupTemporaryUploads = async (files = []) => {
  await Promise.all(files.map((file) => cleanupTemporaryUpload(file)));
};

const uploadMediaFilesToR2 = async (files, options = {}) => {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  const folder = asString(options.folder);
  const resourceType = asString(options.resourceType);
  const failureMessage = asString(options.failureMessage) || "Failed to upload media to storage.";

  try {
    return await Promise.all(
      files.map((file) =>
        uploadMediaFileToR2(file, {
          folder,
          resourceType,
          stripAudio: Boolean(options.stripAudio),
        })
      )
    );
  } catch (error) {
    throw new AppError(asString(error?.message) || failureMessage, httpStatus.INTERNAL_SERVER_ERROR);
  } finally {
    await cleanupTemporaryUploads(files);
  }
};

const escapeRegex = (input) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseNumber = (value, fieldName, min = 0, required = false) => {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new AppError(`${fieldName} is required.`, httpStatus.BAD_REQUEST);
    }
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new AppError(`${fieldName} must be a number >= ${min}.`, httpStatus.BAD_REQUEST);
  }

  return parsed;
};

const parseObjectId = (value, fieldName) => {
  const id = asString(value);
  if (!id) return null;

  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`${fieldName} must be a valid id.`, httpStatus.BAD_REQUEST);
  }

  return id;
};

const parseBoolean = (value, fieldName) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase().trim();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  throw new AppError(`${fieldName} must be a boolean.`, httpStatus.BAD_REQUEST);
};

const parseBooleanLike = (value) => {
  if (typeof value === "boolean") {
    return { matched: true, value };
  }

  if (typeof value === "number") {
    if (value === 1) return { matched: true, value: true };
    if (value === 0) return { matched: true, value: false };
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase().trim();
    if (normalized === "true" || normalized === "1") return { matched: true, value: true };
    if (normalized === "false" || normalized === "0") return { matched: true, value: false };
  }

  return { matched: false, value: undefined };
};

const normalizeExerciseExecutionMode = (value) => {
  const normalized = asString(value).toLowerCase().replace(/\s+/g, "_");

  if (
    normalized === "set_reps" ||
    normalized === "sets_reps" ||
    normalized === "set_rep" ||
    normalized === "sets_rep" ||
    normalized === "sets" ||
    normalized === "reps" ||
    normalized === "rep" ||
    normalized === "normal"
  ) {
    return "set_reps";
  }

  if (
    normalized === "countdown" ||
    normalized === "timer" ||
    normalized === "time" ||
    normalized === "duration" ||
    normalized === "timed"
  ) {
    return "countdown";
  }

  throw new AppError("executionMode must be either set_reps or countdown.", httpStatus.BAD_REQUEST);
};

const parseExecutionModeFromBody = (body) => {
  const executionModeInput = getField(body, ["executionMode", "exerciseMode", "mode"]);
  const countdownModeInput = getField(body, ["countdown"]);

  let fromExecutionMode = undefined;
  if (executionModeInput.provided) {
    fromExecutionMode = normalizeExerciseExecutionMode(executionModeInput.value);
  }

  let fromCountdown = undefined;
  if (countdownModeInput.provided) {
    const parsed = parseBooleanLike(countdownModeInput.value);
    if (parsed.matched) {
      fromCountdown = parsed.value ? "countdown" : "set_reps";
    }
  }

  if (fromExecutionMode && fromCountdown && fromExecutionMode !== fromCountdown) {
    throw new AppError(
      "executionMode and countdown mode flag are conflicting. Choose one mode only.",
      httpStatus.BAD_REQUEST
    );
  }

  return {
    provided: Boolean(executionModeInput.provided || fromCountdown),
    value: fromExecutionMode || fromCountdown,
  };
};

const getDurationInputFromBody = (body) => {
  const directDurationInput = getField(body, ["durationSeconds", "countdownSeconds", "time", "seconds"]);
  if (directDurationInput.provided) {
    return directDurationInput;
  }

  const countdownInput = getField(body, ["countdown"]);
  if (!countdownInput.provided) {
    return { provided: false, value: undefined };
  }

  const parsedBoolean = parseBooleanLike(countdownInput.value);
  if (parsedBoolean.matched) {
    return { provided: false, value: undefined };
  }

  return countdownInput;
};

const getDurationValueFromTemplate = (template) => {
  if (template.durationSeconds !== undefined && template.durationSeconds !== null && template.durationSeconds !== "") {
    return template.durationSeconds;
  }

  if (template.countdown !== undefined && template.countdown !== null && template.countdown !== "") {
    const parsedBoolean = parseBooleanLike(template.countdown);
    if (!parsedBoolean.matched) {
      return template.countdown;
    }
  }

  if (template.time !== undefined && template.time !== null && template.time !== "") {
    return template.time;
  }

  if (template.seconds !== undefined && template.seconds !== null && template.seconds !== "") {
    return template.seconds;
  }

  return undefined;
};

const inferExecutionModeFromSets = (sets, fieldName = "defaultSets") => {
  if (!Array.isArray(sets) || sets.length === 0) {
    return undefined;
  }

  let inferredMode = undefined;

  for (let index = 0; index < sets.length; index += 1) {
    const set = sets[index] || {};
    const hasReps = set.reps !== undefined && set.reps !== null;
    const hasDuration = set.durationSeconds !== undefined && set.durationSeconds !== null;

    if (!hasReps && !hasDuration) {
      throw new AppError(
        `${fieldName}[${index}] must include either reps or durationSeconds.`,
        httpStatus.BAD_REQUEST
      );
    }

    const setMode = hasDuration ? "countdown" : "set_reps";
    if (!inferredMode) {
      inferredMode = setMode;
      continue;
    }

    if (inferredMode !== setMode) {
      throw new AppError(
        `${fieldName} mixes set/reps and countdown sets. Choose one exercise mode only.`,
        httpStatus.BAD_REQUEST
      );
    }
  }

  return inferredMode;
};

const normalizeExecutionModeForResponse = (exercise, normalizedSets) => {
  if (exercise?.executionMode === "set_reps" || exercise?.executionMode === "countdown") {
    return exercise.executionMode;
  }

  const hasDuration = normalizedSets.some((set) => set.durationSeconds !== undefined);
  if (hasDuration) {
    return "countdown";
  }

  return "set_reps";
};

const validateSetsByExecutionMode = (sets, executionMode, fieldName = "defaultSets") => {
  if (!executionMode) {
    throw new AppError("executionMode is required. Choose set_reps or countdown.", httpStatus.BAD_REQUEST);
  }

  if (!Array.isArray(sets)) {
    throw new AppError(`${fieldName} must be an array.`, httpStatus.BAD_REQUEST);
  }

  const normalizedMode = normalizeExerciseExecutionMode(executionMode);

  return sets.map((set, index) => {
    const hasReps = set.reps !== undefined && set.reps !== null;
    const hasDuration = set.durationSeconds !== undefined && set.durationSeconds !== null;

    if (normalizedMode === "countdown") {
      if (!hasDuration) {
        throw new AppError(`${fieldName}[${index}] must include durationSeconds in countdown mode.`, httpStatus.BAD_REQUEST);
      }

      return {
        setNumber: set.setNumber,
        reps: set.reps,
        durationSeconds: set.durationSeconds,
        weightKg: set.weightKg,
      };
    }

    if (!hasReps) {
      throw new AppError(`${fieldName}[${index}] must include reps in set_reps mode.`, httpStatus.BAD_REQUEST);
    }

    if (hasDuration) {
      throw new AppError(`${fieldName}[${index}] cannot include durationSeconds in set_reps mode.`, httpStatus.BAD_REQUEST);
    }

    return {
      setNumber: set.setNumber,
      reps: set.reps,
      weightKg: set.weightKg,
    };
  });
};

const normalizeExerciseStatus = (value) => {
  const normalized = asString(value).toLowerCase();
  if (!EXERCISE_STATUSES.has(normalized)) {
    throw new AppError("status must be one of: draft, published, archived.", httpStatus.BAD_REQUEST);
  }

  return normalized;
};

const normalizeUserType = (value) => {
  const cleaned = asString(value).toLowerCase().replace(/\s+/g, "_");

  if (!cleaned || cleaned === "all" || cleaned === "all_user" || cleaned === "normal" || cleaned === "normal_user") {
    return "all_user";
  }

  if (cleaned === "premium" || cleaned === "premium_user") {
    return "premium_user";
  }

  throw new AppError("userType must be either all_user or premium_user.", httpStatus.BAD_REQUEST);
};

const normalizeMediaAsset = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (!value) return null;

  if (typeof value === "string") {
    const url = value.trim();
    if (!url) return null;
    return {
      url,
      publicId: "",
      mimetype: "",
      size: 0,
    };
  }

  if (typeof value !== "object") return null;

  const url = asString(value.url || value.path || value.secure_url);
  if (!url) return null;

  const size = Number(value.size);

  return {
    url,
    publicId: asString(value.publicId || value.public_id || value.filename),
    mimetype: asString(value.mimetype || value.resource_type || value.format),
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
};

const normalizeMediaList = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (value === undefined || value === null || value === "") return [];

  if (Array.isArray(value)) {
    return value.map(normalizeMediaAsset).filter(Boolean);
  }

  const single = normalizeMediaAsset(value);
  return single ? [single] : [];
};

const extractCloudinaryMediaInfoFromUrl = (url) => {
  const rawUrl = asString(url);
  if (!rawUrl || !/res\.cloudinary\.com/i.test(rawUrl)) {
    return { publicId: "", resourceType: "image" };
  }

  try {
    const parsed = new URL(rawUrl);
    const markerMatch = parsed.pathname.match(/\/(image|video)\/upload\//i);
    if (!markerMatch || !markerMatch[0]) {
      return { publicId: "", resourceType: "image" };
    }

    const resourceType = markerMatch[1]?.toLowerCase() === "video" ? "video" : "image";
    const marker = markerMatch[0];
    let publicIdPath = parsed.pathname.slice(parsed.pathname.indexOf(marker) + marker.length);

    publicIdPath = publicIdPath.replace(/^v\d+\//, "");
    publicIdPath = publicIdPath.replace(/\.[^/.]+$/, "");

    return {
      publicId: decodeURIComponent(publicIdPath),
      resourceType,
    };
  } catch {
    return { publicId: "", resourceType: "image" };
  }
};

const getMediaAssetStorageInfo = (asset) => {
  const url = asString(asset?.url);
  const mimetype = asString(asset?.mimetype).toLowerCase();
  const storedId = asString(asset?.publicId);

  const inferredResourceType = mimetype.startsWith("video/") ? "video" : mimetype.startsWith("image/") ? "image" : "";

  if (isR2Url(url)) {
    return {
      provider: "r2",
      key: storedId,
      resourceType: inferredResourceType || (url.includes("/videos/") ? "video" : "image") || "image",
    };
  }

  const parsedFromUrl = extractCloudinaryMediaInfoFromUrl(url);
  const cloudinaryId = storedId || parsedFromUrl.publicId;
  if (cloudinaryId) {
    return {
      provider: "cloudinary",
      key: cloudinaryId,
      resourceType: inferredResourceType || parsedFromUrl.resourceType,
    };
  }

  return { provider: "none", key: "", resourceType: inferredResourceType || "image" };
};

const buildMediaAssetComparisonKey = (asset) => {
  const storageInfo = getMediaAssetStorageInfo(asset);
  if (storageInfo.key) {
    return `${storageInfo.provider}:${storageInfo.resourceType}:${storageInfo.key}`;
  }

  const url = asString(asset?.url);
  if (url) {
    return `url:${url}`;
  }

  return "";
};

const preserveExistingMediaMetadata = (nextAssets, existingAssets) => {
  const normalizedNext = normalizeMediaList(nextAssets);
  const normalizedExisting = normalizeMediaList(existingAssets);

  const existingByUrl = new Map(
    normalizedExisting
      .map((asset) => [asString(asset.url), asset])
      .filter(([url]) => Boolean(url))
  );

  return normalizedNext.map((asset) => {
    const url = asString(asset.url);
    const matchedExisting = existingByUrl.get(url);
    const size = Number(asset.size);

    if (!matchedExisting) {
      return asset;
    }

    const existingSize = Number(matchedExisting.size);

    return {
      url,
      publicId: asString(asset.publicId || matchedExisting.publicId),
      mimetype: asString(asset.mimetype || matchedExisting.mimetype),
      size:
        Number.isFinite(size) && size > 0
          ? size
          : Number.isFinite(existingSize) && existingSize > 0
            ? existingSize
            : 0,
    };
  });
};

const resolveRemovedMediaAssets = (previousAssets, nextAssets) => {
  const previous = normalizeMediaList(previousAssets);
  const next = normalizeMediaList(nextAssets);
  const nextKeys = new Set(next.map((asset) => buildMediaAssetComparisonKey(asset)).filter(Boolean));
  const removedAssets = [];

  for (const previousAsset of previous) {
    const key = buildMediaAssetComparisonKey(previousAsset);
    if (!key || nextKeys.has(key)) {
      continue;
    }

    const storageInfo = getMediaAssetStorageInfo(previousAsset);
    if (storageInfo.key) {
      removedAssets.push(storageInfo);
    }
  }

  return removedAssets;
};

const deleteMediaAssets = async (assets = []) => {
  const uniqueAssets = [];
  const seen = new Set();

  for (const asset of assets) {
    const key = asString(asset?.key);
    const provider = asset?.provider === "r2" ? "r2" : "cloudinary";
    const resourceType = asString(asset?.resourceType).toLowerCase() === "video" ? "video" : "image";
    if (!key) continue;

    const dedupeKey = `${provider}:${resourceType}:${key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    uniqueAssets.push({ provider, key, resourceType });
  }

  if (uniqueAssets.length === 0) {
    return;
  }

  await Promise.allSettled(
    uniqueAssets.map((asset) =>
      asset.provider === "r2"
        ? deleteR2ObjectByKey(asset.key)
        : deleteCloudinaryMediaByPublicId(asset.key, { resourceType: asset.resourceType })
    )
  );
};

const isAbsoluteHttpUrl = (value) => /^https?:\/\//i.test(asString(value));

const convertMediaAssetsToR2IfNeeded = async (rawValue, options = {}) => {
  const assets = normalizeMediaList(rawValue);
  if (assets.length === 0) {
    return assets;
  }

  const folder = asString(options.folder);
  const resourceType = asString(options.resourceType).toLowerCase() === "video" ? "video" : "image";
  const failureMessage = asString(options.failureMessage) || "Failed to upload media URL to storage.";

  try {
    const converted = await Promise.all(
      assets.map(async (asset) => {
        const storageInfo = getMediaAssetStorageInfo(asset);
        if (storageInfo.key) {
          return asset;
        }

        const sourceUrl = asString(asset?.url);
        if (!isAbsoluteHttpUrl(sourceUrl)) {
          return asset;
        }

        return uploadMediaUrlToR2(sourceUrl, {
          folder,
          resourceType,
        });
      })
    );

    return converted;
  } catch (error) {
    throw new AppError(asString(error?.message) || failureMessage, httpStatus.INTERNAL_SERVER_ERROR);
  }
};

const normalizeStringList = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (value === undefined || value === null || value === "") return [];

  if (Array.isArray(value)) {
    return value
      .map((item) => asString(item))
      .map((item) => item.replace(/^[-\u2022*\u00B7]+\s*/, ""))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n|,|\u2022/)
      .map((item) => item.trim().replace(/^[-\u2022*\u00B7]+\s*/, ""))
      .filter(Boolean);
  }

  return [];
};

const normalizeSetTemplates = (rawValue, fieldName = "defaultSets") => {
  const value = parseMaybeJson(rawValue);
  if (value === undefined || value === null || value === "") return [];

  let templates = [];
  if (Array.isArray(value)) {
    templates = value;
  } else if (typeof value === "object") {
    templates = [value];
  } else {
    throw new AppError(`${fieldName} must be an array of sets or a set object.`, httpStatus.BAD_REQUEST);
  }

  return templates.map((template, index) => {
    if (!template || typeof template !== "object") {
      throw new AppError(`${fieldName}[${index}] must be an object.`, httpStatus.BAD_REQUEST);
    }

    const setNumber = parseNumber(template.setNumber ?? index + 1, `${fieldName}[${index}].setNumber`, 1, true);
    const reps = parseNumber(template.reps ?? template.targetReps, `${fieldName}[${index}].reps`, 0, false);
    const durationSeconds = parseNumber(
      getDurationValueFromTemplate(template),
      `${fieldName}[${index}].durationSeconds`,
      0,
      false
    );
    const weightKg = parseNumber(template.weightKg ?? template.weight, `${fieldName}[${index}].weightKg`, 0, false) ?? 1;

    if (reps === undefined && durationSeconds === undefined) {
      throw new AppError(
        `${fieldName}[${index}] must include either reps or durationSeconds/countdown.`,
        httpStatus.BAD_REQUEST
      );
    }

    return {
      setNumber: Math.floor(setNumber),
      reps,
      durationSeconds,
      weightKg,
    };
  });
};

const parseDefaultSetsFromBody = (body, executionModeHint) => {
  const defaultSetsInput = getField(body, ["defaultSets", "setTemplates", "exerciseSets"]);
  const setCountInput = getField(body, ["sets", "setCount", "totalSets"]);
  const repsInput = getField(body, ["reps", "targetReps"]);
  const durationInput = getDurationInputFromBody(body);
  const weightInput = getField(body, ["weightKg", "weight"]);

  const hasValue = (input) => input !== undefined && input !== null && input !== "";
  const hasAnyInput =
    hasValue(defaultSetsInput.value) ||
    hasValue(setCountInput.value) ||
    hasValue(repsInput.value) ||
    hasValue(durationInput.value) ||
    hasValue(weightInput.value);

  if (!hasAnyInput) {
    return { provided: false, value: undefined, executionMode: undefined };
  }

  if (defaultSetsInput.provided) {
    const templates = normalizeSetTemplates(defaultSetsInput.value, "defaultSets");
    const inferredMode = inferExecutionModeFromSets(templates, "defaultSets");
    const executionMode = executionModeHint || inferredMode;

    return {
      provided: true,
      value: validateSetsByExecutionMode(templates, executionMode, "defaultSets"),
      executionMode,
    };
  }

  const setCount = parseNumber(setCountInput.value ?? 1, "sets", 1, false) ?? 1;
  const reps = parseNumber(repsInput.value, "reps", 0, false);
  const durationSeconds = parseNumber(durationInput.value, "durationSeconds", 0, false);
  const weightKg = parseNumber(weightInput.value, "weightKg", 0, false) ?? 1;

  const inferredMode = durationSeconds !== undefined ? "countdown" : reps !== undefined ? "set_reps" : undefined;
  const executionMode = executionModeHint || inferredMode;

  if (!executionMode) {
    throw new AppError(
      "Provide reps or durationSeconds and choose executionMode (set_reps or countdown).",
      httpStatus.BAD_REQUEST
    );
  }

  const defaultSets = Array.from({ length: Math.floor(setCount) }, (_, index) => ({
    setNumber: index + 1,
    reps,
    durationSeconds,
    weightKg,
  }));

  return {
    provided: true,
    value: validateSetsByExecutionMode(defaultSets, executionMode, "defaultSets"),
    executionMode,
  };
};

const normalizeDefaultSetsForResponse = (rawSets) =>
  Array.isArray(rawSets)
    ? rawSets
      .filter((set) => set && typeof set === "object")
      .map((set, index) => ({
        setNumber: Number.isFinite(Number(set.setNumber)) && Number(set.setNumber) >= 1 ? Math.floor(Number(set.setNumber)) : index + 1,
        reps: Number.isFinite(Number(set.reps)) ? Number(set.reps) : undefined,
        durationSeconds: Number.isFinite(Number(set.durationSeconds)) ? Number(set.durationSeconds) : undefined,
        weightKg: Number.isFinite(Number(set.weightKg)) && Number(set.weightKg) >= 0 ? Number(set.weightKg) : 1,
      }))
    : [];

const buildPagination = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

const parsePage = (value) => {
  const page = Number(value || 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
};

const parseLimit = (value, defaultValue = 10, maxValue = 100) => {
  const limit = Number(value || defaultValue);
  if (!Number.isFinite(limit) || limit <= 0) return defaultValue;
  return Math.min(Math.floor(limit), maxValue);
};

const ensurePremiumUserAssignable = async (userId) => {
  const parsedId = parseObjectId(userId, "assignedUser");
  if (!parsedId) {
    throw new AppError("assignedUser is required for premium_user exercises.", httpStatus.BAD_REQUEST);
  }

  const user = await User.findById(parsedId).select("firstName email role selectedPlan subscriptionStatus isActive");
  if (!user || !user.isActive) {
    throw new AppError("Assigned user was not found.", httpStatus.NOT_FOUND);
  }

  if (user.role === "admin") {
    throw new AppError("Assigned user must be a regular user account.", httpStatus.BAD_REQUEST);
  }

  if (!isPremiumActiveUser(user)) {
    throw new AppError(
      "Assigned user must have an active premium subscription before receiving private exercises.",
      httpStatus.BAD_REQUEST
    );
  }

  return user;
};

const toAssignedUser = (assignedUser) => {
  if (assignedUser && typeof assignedUser === "object" && assignedUser._id) {
    return {
      id: assignedUser._id,
      firstName: assignedUser.firstName,
      email: assignedUser.email,
    };
  }
  return assignedUser || null;
};

const buildExerciseSummary = (exercise, programNames = []) => {
  const defaultSets = normalizeDefaultSetsForResponse(exercise.defaultSets);
  const primarySet = defaultSets[0] || null;
  const executionMode = normalizeExecutionModeForResponse(exercise, defaultSets);
  const isCountdown = executionMode === "countdown";

  return {
    id: exercise._id,
    exerciseName: exercise.exerciseName,
    userType: exercise.userType,
    plan: exercise.userType,
    assignedUser: toAssignedUser(exercise.assignedUser),
    description: exercise.description,
    keyBenefits: exercise.keyBenefits || [],
    muscleGroups: exercise.muscleGroups || [],
    exerciseImage: toMediaUrl(exercise.exerciseImages?.[0]),
    demoVideo: toMediaUrl(exercise.demoVideos?.[0]),
    targetMuscleImage: toMediaUrl(exercise.targetMuscleImages?.[0]),
    exerciseImages: toMediaUrlList(exercise.exerciseImages),
    targetMuscleImages: toMediaUrlList(exercise.targetMuscleImages),
    demoVideos: toMediaUrlList(exercise.demoVideos),
    defaultSets,
    executionMode,
    sets: defaultSets.length,
    reps: primarySet?.reps ?? null,
    countdown: isCountdown,
    durationSeconds: isCountdown ? primarySet?.durationSeconds ?? null : null,
    weightKg: primarySet?.weightKg ?? 1,
    isVisibleInLibrary: exercise.isVisibleInLibrary,
    status: exercise.status,
    isActive: exercise.isActive,
    programNames,
    programCount: programNames.length,
    createdAt: exercise.createdAt,
    updatedAt: exercise.updatedAt,
  };
};

const buildExerciseDetails = (exercise, programNames = []) => buildExerciseSummary(exercise, programNames);

const getProgramUsageMap = async (exerciseIds) => {
  const idList = Array.isArray(exerciseIds)
    ? exerciseIds
        .map((id) => id?.toString?.() || null)
        .filter(Boolean)
    : [];

  if (idList.length === 0) {
    return new Map();
  }

  const usageMap = new Map(idList.map((id) => [id, []]));

  const programs = await Program.find({
    isActive: true,
    status: { $ne: "archived" },
    exerciseRefs: { $in: idList },
  }).select("programName exerciseRefs");

  for (const program of programs) {
    for (const exerciseId of program.exerciseRefs || []) {
      const key = exerciseId.toString();
      if (!usageMap.has(key)) continue;

      const names = usageMap.get(key);
      if (!names.includes(program.programName)) {
        names.push(program.programName);
      }
    }
  }

  return usageMap;
};

const buildCreatePayload = async (body) => {
  const parsedBody = body || {};

  const exerciseName = asString(getField(parsedBody, ["exerciseName", "name", "exerciseTitle", "title"]).value);
  if (!exerciseName) {
    throw new AppError("exerciseName is required.", httpStatus.BAD_REQUEST);
  }

  const userType = normalizeUserType(getField(parsedBody, ["userType", "plan"]).value || "all_user");
  const description = asString(getField(parsedBody, ["description", "exerciseDescription", "workoutDescription"]).value);
  const keyBenefits = normalizeStringList(getField(parsedBody, ["keyBenefits", "benefits"]).value);
  const muscleGroups = normalizeStringList(getField(parsedBody, ["muscleGroups", "targetMuscles", "tags"]).value);
  const exerciseImages = normalizeMediaList(getField(parsedBody, ["exerciseImages", "exerciseImage", "image"]).value);
  const targetMuscleImages = normalizeMediaList(
    getField(parsedBody, ["targetMuscleImages", "targetMuscleImage", "muscleImages", "muscleImage"]).value
  );
  const demoVideos = normalizeMediaList(
    getField(parsedBody, DEMO_VIDEO_FIELDS).value
  );
  const executionModeInput = parseExecutionModeFromBody(parsedBody);
  const defaultSetsInput = parseDefaultSetsFromBody(parsedBody, executionModeInput.value);
  const executionMode = executionModeInput.value || defaultSetsInput.executionMode;
  const status = normalizeExerciseStatus(getField(parsedBody, ["status"]).value || "published");
  const isVisibleInLibrary = parseBoolean(
    getField(parsedBody, ["isVisibleInLibrary", "visibleInLibrary", "isVisible"]).value,
    "isVisibleInLibrary"
  );

  if (exerciseImages.length === 0) {
    throw new AppError("At least one exercise image is required.", httpStatus.BAD_REQUEST);
  }

  if (demoVideos.length === 0) {
    throw new AppError("At least one exercise demo video is required.", httpStatus.BAD_REQUEST);
  }

  if (!defaultSetsInput.provided || defaultSetsInput.value.length === 0) {
    throw new AppError(
      "Exercise setup is required. Provide sets with either reps mode or countdown mode.",
      httpStatus.BAD_REQUEST
    );
  }

  if (!executionMode) {
    throw new AppError("executionMode is required. Choose set_reps or countdown.", httpStatus.BAD_REQUEST);
  }

  let assignedUser = null;
  if (userType === "premium_user") {
    const assignedInput = getField(parsedBody, ["assignedUser", "assignedUserId", "targetUserId", "userId"]).value;
    const premiumUser = await ensurePremiumUserAssignable(assignedInput);
    assignedUser = premiumUser._id;
  }

  return {
    exerciseName,
    userType,
    assignedUser,
    description,
    keyBenefits,
    muscleGroups,
    exerciseImages,
    targetMuscleImages,
    demoVideos,
    defaultSets: defaultSetsInput.value,
    executionMode,
    status,
    isVisibleInLibrary: isVisibleInLibrary ?? true,
    isActive: status !== "archived",
  };
};

const buildUpdatePayload = async (body, currentExercise) => {
  const parsedBody = body || {};
  const updates = {};

  const nameInput = getField(parsedBody, ["exerciseName", "name", "exerciseTitle", "title"]);
  if (nameInput.provided) {
    const exerciseName = asString(nameInput.value);
    if (!exerciseName) {
      throw new AppError("exerciseName cannot be empty.", httpStatus.BAD_REQUEST);
    }
    updates.exerciseName = exerciseName;
  }

  const descriptionInput = getField(parsedBody, ["description", "exerciseDescription", "workoutDescription"]);
  if (descriptionInput.provided) {
    updates.description = asString(descriptionInput.value);
  }

  const keyBenefitsInput = getField(parsedBody, ["keyBenefits", "benefits"]);
  if (keyBenefitsInput.provided) {
    updates.keyBenefits = normalizeStringList(keyBenefitsInput.value);
  }

  const muscleGroupsInput = getField(parsedBody, ["muscleGroups", "targetMuscles", "tags"]);
  if (muscleGroupsInput.provided) {
    updates.muscleGroups = normalizeStringList(muscleGroupsInput.value);
  }

  const exerciseImagesInput = getField(parsedBody, ["exerciseImages", "exerciseImage", "image"]);
  if (exerciseImagesInput.provided) {
    const exerciseImages = normalizeMediaList(exerciseImagesInput.value);
    if (exerciseImages.length === 0) {
      throw new AppError("At least one exercise image is required.", httpStatus.BAD_REQUEST);
    }
    updates.exerciseImages = preserveExistingMediaMetadata(exerciseImages, currentExercise.exerciseImages);
  }

  const targetMuscleImagesInput = getField(
    parsedBody,
    ["targetMuscleImages", "targetMuscleImage", "muscleImages", "muscleImage"]
  );
  if (targetMuscleImagesInput.provided) {
    updates.targetMuscleImages = preserveExistingMediaMetadata(
      normalizeMediaList(targetMuscleImagesInput.value),
      currentExercise.targetMuscleImages
    );
  }

  const demoVideosInput = getField(parsedBody, DEMO_VIDEO_FIELDS);
  if (demoVideosInput.provided) {
    const demoVideos = normalizeMediaList(demoVideosInput.value);
    if (demoVideos.length === 0) {
      throw new AppError("At least one exercise demo video is required.", httpStatus.BAD_REQUEST);
    }
    updates.demoVideos = preserveExistingMediaMetadata(demoVideos, currentExercise.demoVideos);
  }

  const executionModeInput = parseExecutionModeFromBody(parsedBody);
  const defaultSetsInput = parseDefaultSetsFromBody(parsedBody, executionModeInput.value);
  if (defaultSetsInput.provided) {
    if (defaultSetsInput.value.length === 0) {
      throw new AppError(
        "defaultSets cannot be empty. Provide at least one set with reps or durationSeconds.",
        httpStatus.BAD_REQUEST
      );
    }
    updates.defaultSets = defaultSetsInput.value;
    updates.executionMode = defaultSetsInput.executionMode;
  } else if (executionModeInput.provided) {
    const normalizedCurrentSets = normalizeDefaultSetsForResponse(currentExercise.defaultSets);
    if (normalizedCurrentSets.length === 0) {
      throw new AppError(
        "Cannot set executionMode without defaultSets. Provide sets with reps or durationSeconds.",
        httpStatus.BAD_REQUEST
      );
    }

    updates.executionMode = executionModeInput.value;
    updates.defaultSets = validateSetsByExecutionMode(normalizedCurrentSets, executionModeInput.value, "defaultSets");
  }

  const userTypeInput = getField(parsedBody, ["userType", "plan"]);
  const assignedUserInput = getField(parsedBody, ["assignedUser", "assignedUserId", "targetUserId", "userId"]);

  if (userTypeInput.provided || assignedUserInput.provided) {
    const nextUserType = userTypeInput.provided ? normalizeUserType(userTypeInput.value) : currentExercise.userType;
    let nextAssignedUser = assignedUserInput.provided
      ? parseObjectId(assignedUserInput.value, "assignedUser")
      : currentExercise.assignedUser?.toString() || null;

    if (nextUserType === "all_user") {
      nextAssignedUser = null;
    } else {
      const premiumUser = await ensurePremiumUserAssignable(nextAssignedUser);
      nextAssignedUser = premiumUser._id;
    }

    updates.userType = nextUserType;
    updates.assignedUser = nextAssignedUser;
  }

  const visibilityInput = getField(parsedBody, ["isVisibleInLibrary", "visibleInLibrary", "isVisible"]);
  if (visibilityInput.provided) {
    updates.isVisibleInLibrary = parseBoolean(visibilityInput.value, "isVisibleInLibrary");
  }

  const statusInput = getField(parsedBody, ["status"]);
  if (statusInput.provided) {
    const status = normalizeExerciseStatus(statusInput.value);
    updates.status = status;
    if (status === "archived") {
      updates.isActive = false;
    } else if (!Object.hasOwn(updates, "isActive")) {
      updates.isActive = true;
    }
  }

  const isActiveInput = getField(parsedBody, ["isActive"]);
  if (isActiveInput.provided) {
    updates.isActive = parseBoolean(isActiveInput.value, "isActive");
    if (updates.isActive === false) {
      updates.status = "archived";
    }
  }

  return updates;
};

const buildUserAccessibleFilter = (user) => {
  const filter = {
    status: "published",
    isActive: true,
    $or: [{ userType: "all_user", isVisibleInLibrary: true }],
  };

  if (isPremiumActiveUser(user)) {
    filter.$or.push({ userType: "premium_user", assignedUser: user._id });
  }

  return filter;
};

const getExerciseBodyFromRequest = async (req) => {
  let payload = mergeUploadedMediaIntoBody(req.body, req.files, [
    { target: "exerciseImages", fieldNames: EXERCISE_IMAGE_FIELDS },
    { target: "targetMuscleImages", fieldNames: TARGET_MUSCLE_IMAGE_FIELDS },
    { target: "demoVideos", fieldNames: DEMO_VIDEO_FIELDS },
  ]);

  const exerciseImageFiles = getUploadedFilesByFieldNames(req.files, EXERCISE_IMAGE_FIELDS);
  const targetMuscleImageFiles = getUploadedFilesByFieldNames(req.files, TARGET_MUSCLE_IMAGE_FIELDS);
  const demoVideoFiles = getUploadedFilesByFieldNames(req.files, DEMO_VIDEO_FIELDS);

  if (exerciseImageFiles.length > 0) {
    payload = {
      ...(payload || {}),
      exerciseImages: await uploadMediaFilesToR2(exerciseImageFiles, {
        folder: EXERCISE_IMAGE_FOLDER,
        resourceType: "image",
        failureMessage: "Failed to upload exercise images to storage.",
      }),
    };
  }

  if (targetMuscleImageFiles.length > 0) {
    payload = {
      ...(payload || {}),
      targetMuscleImages: await uploadMediaFilesToR2(targetMuscleImageFiles, {
        folder: TARGET_MUSCLE_IMAGE_FOLDER,
        resourceType: "image",
        failureMessage: "Failed to upload target muscle images to storage.",
      }),
    };
  }

  if (demoVideoFiles.length > 0) {
    const muteVideo = parseBoolean(
      getField(req.body || {}, ["muteVideo", "stripAudio", "muteAudio"]).value,
      "muteVideo"
    );

    payload = {
      ...(payload || {}),
      demoVideos: await uploadMediaFilesToR2(demoVideoFiles, {
        folder: DEMO_VIDEO_FOLDER,
        resourceType: "video",
        stripAudio: muteVideo === true,
        failureMessage: "Failed to upload demo videos to storage.",
      }),
    };
  }

  if (Object.hasOwn(payload, "exerciseImages")) {
    payload = {
      ...(payload || {}),
      exerciseImages: await convertMediaAssetsToR2IfNeeded(payload.exerciseImages, {
        folder: EXERCISE_IMAGE_FOLDER,
        resourceType: "image",
        failureMessage: "Failed to migrate exercise images to storage.",
      }),
    };
  }

  if (Object.hasOwn(payload, "targetMuscleImages")) {
    payload = {
      ...(payload || {}),
      targetMuscleImages: await convertMediaAssetsToR2IfNeeded(payload.targetMuscleImages, {
        folder: TARGET_MUSCLE_IMAGE_FOLDER,
        resourceType: "image",
        failureMessage: "Failed to migrate target muscle images to storage.",
      }),
    };
  }

  if (Object.hasOwn(payload, "demoVideos")) {
    payload = {
      ...(payload || {}),
      demoVideos: await convertMediaAssetsToR2IfNeeded(payload.demoVideos, {
        folder: DEMO_VIDEO_FOLDER,
        resourceType: "video",
        failureMessage: "Failed to migrate demo videos to storage.",
      }),
    };
  }

  return payload;
};

export const createExercise = catchAsync(async (req, res) => {
  const payload = await buildCreatePayload(await getExerciseBodyFromRequest(req));

  const exercise = await Exercise.create({
    ...payload,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  const populated = await Exercise.findById(exercise._id).populate("assignedUser", "firstName email");

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Exercise created successfully.",
    data: buildExerciseDetails(populated),
  });
});

export const getAdminExercises = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 2000);
  const skip = (page - 1) * limit;

  const filter = {};

  if (req.query.userType || req.query.plan) {
    filter.userType = normalizeUserType(req.query.userType || req.query.plan);
  }

  if (req.query.status) {
    filter.status = normalizeExerciseStatus(req.query.status);
  }

  if (Object.hasOwn(req.query, "isActive")) {
    filter.isActive = parseBoolean(req.query.isActive, "isActive");
  }

  if (Object.hasOwn(req.query, "isVisibleInLibrary")) {
    filter.isVisibleInLibrary = parseBoolean(req.query.isVisibleInLibrary, "isVisibleInLibrary");
  }

  if (req.query.assignedUser) {
    filter.assignedUser = parseObjectId(req.query.assignedUser, "assignedUser");
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$or = [
      { exerciseName: pattern },
      { description: pattern },
      { keyBenefits: pattern },
      { muscleGroups: pattern },
    ];
  }

  const [exercises, total] = await Promise.all([
    Exercise.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("assignedUser", "firstName email"),
    Exercise.countDocuments(filter),
  ]);

  const usageMap = await getProgramUsageMap(exercises.map((exercise) => exercise._id));

  res.status(httpStatus.OK).json({
    success: true,
    data: exercises.map((exercise) => buildExerciseSummary(exercise, usageMap.get(exercise._id.toString()) || [])),
    meta: buildPagination(page, limit, total),
  });
});

export const getAdminExerciseById = catchAsync(async (req, res) => {
  const { exerciseId } = req.params;
  if (!mongoose.isValidObjectId(exerciseId)) {
    throw new AppError("Invalid exercise id.", httpStatus.BAD_REQUEST);
  }

  const exercise = await Exercise.findById(exerciseId).populate("assignedUser", "firstName email");
  if (!exercise) {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  const usageMap = await getProgramUsageMap([exercise._id]);

  res.status(httpStatus.OK).json({
    success: true,
    data: buildExerciseDetails(exercise, usageMap.get(exercise._id.toString()) || []),
  });
});

export const updateAdminExercise = catchAsync(async (req, res) => {
  const { exerciseId } = req.params;
  if (!mongoose.isValidObjectId(exerciseId)) {
    throw new AppError("Invalid exercise id.", httpStatus.BAD_REQUEST);
  }

  const exercise = await Exercise.findById(exerciseId);
  if (!exercise) {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  const previousExerciseImages = normalizeMediaList(exercise.exerciseImages);
  const previousTargetMuscleImages = normalizeMediaList(exercise.targetMuscleImages);
  const previousDemoVideos = normalizeMediaList(exercise.demoVideos);

  const updates = await buildUpdatePayload(await getExerciseBodyFromRequest(req), exercise);
  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields were provided for update.", httpStatus.BAD_REQUEST);
  }

  Object.assign(exercise, updates, { updatedBy: req.user._id });
  await exercise.save();

  const removedMediaAssets = [
    ...resolveRemovedMediaAssets(previousExerciseImages, exercise.exerciseImages),
    ...resolveRemovedMediaAssets(previousTargetMuscleImages, exercise.targetMuscleImages),
    ...resolveRemovedMediaAssets(previousDemoVideos, exercise.demoVideos),
  ];
  await deleteMediaAssets(removedMediaAssets);

  const populated = await Exercise.findById(exercise._id).populate("assignedUser", "firstName email");
  const usageMap = await getProgramUsageMap([exercise._id]);

  res.status(httpStatus.OK).json({
    success: true,
    message: "Exercise updated successfully.",
    data: buildExerciseDetails(populated, usageMap.get(exercise._id.toString()) || []),
  });
});

export const updateExerciseVisibility = catchAsync(async (req, res) => {
  const { exerciseId } = req.params;
  if (!mongoose.isValidObjectId(exerciseId)) {
    throw new AppError("Invalid exercise id.", httpStatus.BAD_REQUEST);
  }

  const exercise = await Exercise.findById(exerciseId);
  if (!exercise) {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  const visibilityInput = getField(req.body || {}, ["isVisibleInLibrary", "visibleInLibrary", "isVisible"]);
  if (visibilityInput.provided) {
    exercise.isVisibleInLibrary = parseBoolean(visibilityInput.value, "isVisibleInLibrary");
  } else {
    exercise.isVisibleInLibrary = !exercise.isVisibleInLibrary;
  }

  exercise.updatedBy = req.user._id;
  await exercise.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Exercise visibility updated successfully.",
    data: {
      id: exercise._id,
      isVisibleInLibrary: exercise.isVisibleInLibrary,
    },
  });
});

export const deleteAdminExercise = catchAsync(async (req, res) => {
  const { exerciseId } = req.params;
  if (!mongoose.isValidObjectId(exerciseId)) {
    throw new AppError("Invalid exercise id.", httpStatus.BAD_REQUEST);
  }

  const exercise = await Exercise.findById(exerciseId);
  if (!exercise) {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  const exerciseAssets = [
    ...normalizeMediaList(exercise.exerciseImages),
    ...normalizeMediaList(exercise.targetMuscleImages),
    ...normalizeMediaList(exercise.demoVideos),
  ];
  const mediaAssetsToDelete = exerciseAssets.map((asset) => getMediaAssetStorageInfo(asset)).filter((asset) => asset.key);

  await Exercise.deleteOne({ _id: exercise._id });
  await deleteMediaAssets(mediaAssetsToDelete);
  await UserExerciseSetting.deleteMany({ exercise: exercise._id });

  const affectedPrograms = await Program.find({ exerciseRefs: exercise._id });
  await Promise.all(
    affectedPrograms.map(async (program) => {
      program.exerciseRefs = (program.exerciseRefs || []).filter(
        (exerciseRefId) => exerciseRefId.toString() !== exercise._id.toString()
      );
      program.totalExercises = program.exerciseRefs.length;
      program.updatedBy = req.user._id;
      await program.save({ validateBeforeSave: false });
    })
  );

  res.status(httpStatus.OK).json({
    success: true,
    message: "Exercise deleted successfully.",
    data: {
      removedFromPrograms: affectedPrograms.length,
    },
  });
});

export const listPremiumUsersForExercises = catchAsync(async (req, res) => {
  const search = asString(req.query.search);

  const query = {
    role: "user",
    isActive: true,
    selectedPlan: { $in: PREMIUM_PLAN_KEYS },
    subscriptionStatus: "active",
  };

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    query.$or = [{ firstName: pattern }, { email: pattern }];
  }

  const users = await User.find(query)
    .sort({ firstName: 1, email: 1 })
    .limit(100)
    .select("firstName email selectedPlan subscriptionStatus");

  res.status(httpStatus.OK).json({
    success: true,
    data: users.map((user) => ({
      id: user._id,
      firstName: user.firstName,
      email: user.email,
      selectedPlan: user.selectedPlan,
      subscriptionStatus: user.subscriptionStatus,
    })),
  });
});

export const getPublicExerciseLibrary = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = {
    status: "published",
    isActive: true,
    userType: "all_user",
    isVisibleInLibrary: true,
  };

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$or = [
      { exerciseName: pattern },
      { description: pattern },
      { keyBenefits: pattern },
      { muscleGroups: pattern },
    ];
  }

  const [exercises, total] = await Promise.all([
    Exercise.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Exercise.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: exercises.map((exercise) => buildExerciseSummary(exercise)),
    meta: buildPagination(page, limit, total),
  });
});

export const getMyPrivateExercises = catchAsync(async (req, res) => {
  if (!isPremiumActiveUser(req.user)) {
    throw new AppError("Active premium subscription required to access private exercises.", httpStatus.FORBIDDEN);
  }

  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = {
    status: "published",
    isActive: true,
    userType: "premium_user",
    assignedUser: req.user._id,
  };

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$or = [
      { exerciseName: pattern },
      { description: pattern },
      { keyBenefits: pattern },
      { muscleGroups: pattern },
    ];
  }

  const [exercises, total] = await Promise.all([
    Exercise.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Exercise.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: exercises.map((exercise) => buildExerciseSummary(exercise)),
    meta: buildPagination(page, limit, total),
  });
});

export const getAllAccessibleExercises = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = buildUserAccessibleFilter(req.user);

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$and = [
      {
        $or: [
          { exerciseName: pattern },
          { description: pattern },
          { keyBenefits: pattern },
          { muscleGroups: pattern },
        ],
      },
    ];
  }

  const [exercises, total] = await Promise.all([
    Exercise.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Exercise.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: exercises.map((exercise) => buildExerciseSummary(exercise)),
    meta: buildPagination(page, limit, total),
  });
});

export const getExerciseByIdForUser = catchAsync(async (req, res) => {
  const { exerciseId } = req.params;
  if (!mongoose.isValidObjectId(exerciseId)) {
    throw new AppError("Invalid exercise id.", httpStatus.BAD_REQUEST);
  }

  const exercise = await Exercise.findById(exerciseId).populate("assignedUser", "firstName email");
  if (!exercise || !exercise.isActive) {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  if (req.user.role === "admin") {
    const usageMap = await getProgramUsageMap([exercise._id]);
    return res.status(httpStatus.OK).json({
      success: true,
      data: buildExerciseDetails(exercise, usageMap.get(exercise._id.toString()) || []),
    });
  }

  if (exercise.status !== "published") {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  const isPublicExercise = exercise.userType === "all_user";
  const isAssignedPremiumExercise =
    isPremiumActiveUser(req.user) &&
    exercise.userType === "premium_user" &&
    exercise.assignedUser &&
    exercise.assignedUser._id.toString() === req.user._id.toString();

  if (!isPublicExercise && !isAssignedPremiumExercise) {
    throw new AppError("You are not allowed to access this exercise.", httpStatus.FORBIDDEN);
  }

  return res.status(httpStatus.OK).json({
    success: true,
    data: buildExerciseDetails(exercise),
  });
});
