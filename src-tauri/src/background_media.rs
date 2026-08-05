use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::Manager;
use uuid::Uuid;

const ALLOWED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "avif", "mp4"];

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundMedia {
    id: String,
    name: String,
    path: String,
}

fn media_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("background-media");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

/// 返回保存背景素材的应用数据目录；若目录尚未存在则一并创建。
#[tauri::command]
pub fn background_media_directory(app: tauri::AppHandle) -> Result<String, String> {
    Ok(media_directory(&app)?.to_string_lossy().into_owned())
}

fn extension(path: &Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
        .ok_or_else(|| "Background media must have a supported file extension".to_string())?;
    if ALLOWED_EXTENSIONS.contains(&extension.as_str()) {
        Ok(extension)
    } else {
        Err("Supported background media: PNG, JPG, JPEG, WebP, GIF, AVIF, and MP4".to_string())
    }
}

fn definition(path: PathBuf) -> Option<BackgroundMedia> {
    let file_name = path.file_name()?.to_str()?;
    let (id, name) = file_name.split_once("--")?;
    Uuid::parse_str(id).ok()?;
    if extension(&path).is_err() {
        return None;
    }
    Some(BackgroundMedia {
        id: id.to_string(),
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
    })
}

fn content_hash(path: &Path) -> Result<[u8; 32], String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut hash = Sha256::new();
    let mut buffer = [0; 8192];

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }

    Ok(hash.finalize().into())
}

fn matching_media(directory: &Path, source: &Path) -> Result<Option<BackgroundMedia>, String> {
    let source_size = source.metadata().map_err(|error| error.to_string())?.len();
    let source_hash = content_hash(source)?;

    for entry in fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let path = entry.path();
        if !path.is_file()
            || path.metadata().map_err(|error| error.to_string())?.len() != source_size
        {
            continue;
        }
        let Some(media) = definition(path.clone()) else {
            continue;
        };
        if content_hash(&path)? == source_hash {
            return Ok(Some(media));
        }
    }

    Ok(None)
}

#[tauri::command]
pub fn list_background_media(app: tauri::AppHandle) -> Result<Vec<BackgroundMedia>, String> {
    let directory = media_directory(&app)?;
    let mut media = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            definition(path).map(|definition| (modified, definition))
        })
        .collect::<Vec<_>>();
    media.sort_by_key(|right| std::cmp::Reverse(right.0));
    Ok(media
        .into_iter()
        .map(|(_, definition)| definition)
        .collect())
}

#[tauri::command]
pub fn import_background_media(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<BackgroundMedia, String> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("Selected background media is not a file".to_string());
    }
    extension(&source)?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Selected background media has an invalid file name".to_string())?
        .to_string();
    let directory = media_directory(&app)?;
    if let Some(media) = matching_media(&directory, &source)? {
        return Ok(media);
    }

    let id = Uuid::new_v4().to_string();
    let destination = directory.join(format!("{id}--{name}"));
    fs::copy(&source, &destination).map_err(|error| error.to_string())?;

    Ok(BackgroundMedia {
        id,
        name,
        path: destination.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_cached_media_by_content_instead_of_file_name() {
        let directory =
            std::env::temp_dir().join(format!("background-media-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("renamed-cloud.jpg");
        let id = Uuid::new_v4();
        let cached = directory.join(format!("{id}--cloud.jpg"));
        fs::write(&source, b"same image bytes").unwrap();
        fs::write(&cached, b"same image bytes").unwrap();

        let media = matching_media(&directory, &source).unwrap().unwrap();

        assert_eq!(media.id, id.to_string());
        assert_eq!(media.path, cached.to_string_lossy());
        fs::remove_dir_all(directory).unwrap();
    }
}

#[tauri::command]
pub fn delete_background_media(app: tauri::AppHandle, id: String) -> Result<(), String> {
    Uuid::parse_str(&id).map_err(|_| "Invalid background media id".to_string())?;
    let prefix = format!("{id}--");
    let path = fs::read_dir(media_directory(&app)?)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .ok_or_else(|| "Background media was not found".to_string())?;
    fs::remove_file(path).map_err(|error| error.to_string())
}
