use jni::objects::{JClass, JString};
use jni::sys::{jboolean, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;

use crate::{download_file, get_latest_file, search_modrinth};

/// Java_com_yuyuframe_launcheragent_runtime_content_ContentBridge_searchModrinth
#[no_mangle]
pub extern "system" fn Java_com_yuyuframe_launcheragent_runtime_content_ContentBridge_searchModrinth<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    query: JString<'local>,
    project_type: JString<'local>,
) -> JString<'local> {
    let query: String = env.get_string(&query).unwrap().into();
    let project_type: String = env.get_string(&project_type).unwrap().into();

    let result = search_modrinth(&query, &project_type).unwrap_or_else(|e| {
        format!("{{\"error\":\"{}\"}}", e.replace('"', "'"))
    });

    env.new_string(result).unwrap_or_else(|_| {
        env.new_string("{\"error\":\"encodage résultat échoué\"}").unwrap()
    })
}

/// Java_com_yuyuframe_launcheragent_runtime_content_ContentBridge_getLatestFile
#[no_mangle]
pub extern "system" fn Java_com_yuyuframe_launcheragent_runtime_content_ContentBridge_getLatestFile<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    project_id: JString<'local>,
) -> JString<'local> {
    let project_id: String = env.get_string(&project_id).unwrap().into();

    let result = get_latest_file(&project_id).unwrap_or_else(|e| {
        format!("{{\"error\":\"{}\"}}", e.replace('"', "'"))
    });

    env.new_string(result).unwrap_or_else(|_| {
        env.new_string("{\"error\":\"encodage résultat échoué\"}").unwrap()
    })
}

/// Java_com_yuyuframe_launcheragent_runtime_content_ContentBridge_downloadFile
#[no_mangle]
pub extern "system" fn Java_com_yuyuframe_launcheragent_runtime_content_ContentBridge_downloadFile<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    url: JString<'local>,
    dest_path: JString<'local>,
) -> jboolean {
    let url: String = env.get_string(&url).unwrap().into();
    let dest_path: String = env.get_string(&dest_path).unwrap().into();

    match download_file(&url, &dest_path) {
        Ok(()) => JNI_TRUE,
        Err(_) => JNI_FALSE,
    }
}
