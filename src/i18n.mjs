/**
 * 极简 message catalog：不拼字符串，全部走 key + 占位符。
 * 8 种内置语言覆盖用户可见的结果、错误与主操作；缺失 key 回退到 en-US。
 */

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR'];
export const FALLBACK_LOCALE = 'en-US';

/** 每种语言必须覆盖的核心 key（错误码允许回退，核心结果不允许）。 */
export const CORE_KEYS = [
  'message.success', 'message.partial', 'message.rolled-back', 'message.failed',
  'message.blocked', 'message.safe-mode', 'message.up-to-date', 'message.cancelled',
  'action.retry', 'action.rollback', 'action.copy-command',
];

const M = (success, partial, rolledBack, failed, blocked, safeMode, upToDate, cancelled, retry, rollback, copy) => ({
  'message.success': success,
  'message.partial': partial,
  'message.rolled-back': rolledBack,
  'message.failed': failed,
  'message.blocked': blocked,
  'message.safe-mode': safeMode,
  'message.up-to-date': upToDate,
  'message.cancelled': cancelled,
  'action.retry': retry,
  'action.rollback': rollback,
  'action.copy-command': copy,
});

export const CATALOGS = {
  'zh-CN': {
    ...M(
      '已更新到 {version}。',
      '已更新到 {version}，{count} 个插件已禁用。',
      '已回滚到 {version}。',
      '更新失败：{reason}',
      '核心插件不兼容，更新已阻止。',
      '自动回滚失败，已进入安全模式。',
      '已是最新（{version}）。',
      '已取消，未做任何更改。',
      '重试',
      '回滚',
      '复制修复命令',
    ),
    'error.UPD-101': '无法连接更新源，请检查网络或代理。',
    'error.UPD-102': '更新源返回了无效信息。',
    'error.UPD-103': '当前渠道没有兼容版本。',
    'error.UPD-201': '有插件与新版本不兼容。',
    'error.UPD-202': '核心插件不兼容，已阻止更新。',
    'error.UPD-301': '磁盘空间不足。',
    'error.UPD-302': '没有写入权限。',
    'error.UPD-303': '另一个实例正在更新。',
    'error.UPD-401': '下载失败，已保留当前版本。',
    'error.UPD-402': '完整性校验失败，下载已丢弃。',
    'error.UPD-501': '安装失败。',
    'error.UPD-502': '新版本自检未通过。',
    'error.UPD-503': '插件加载失败超过阈值。',
    'error.UPD-601': '自动回滚失败。',
    'error.UPD-701': '需要更新到更高版本才能继续。',
    'error.UPD-702': '当前为临时运行，无法原地更新。',
  },
  'en-US': {
    ...M(
      'Updated to {version}.',
      'Updated to {version}; {count} plugins disabled.',
      'Rolled back to {version}.',
      'Update failed: {reason}',
      'A core plugin is incompatible; update blocked.',
      'Automatic rollback failed; safe mode enabled.',
      'Up to date ({version}).',
      'Cancelled; no changes were made.',
      'Retry',
      'Roll back',
      'Copy repair command',
    ),
    'error.UPD-101': 'Cannot reach the update source. Check your network or proxy.',
    'error.UPD-102': 'The update source returned invalid data.',
    'error.UPD-103': 'No compatible release in this channel.',
    'error.UPD-201': 'Some plugins are incompatible with the new version.',
    'error.UPD-202': 'A core plugin is incompatible; update blocked.',
    'error.UPD-301': 'Not enough disk space.',
    'error.UPD-302': 'No write permission.',
    'error.UPD-303': 'Another instance is updating.',
    'error.UPD-401': 'Download failed; the current version was kept.',
    'error.UPD-402': 'Integrity check failed; the download was discarded.',
    'error.UPD-501': 'Installation failed.',
    'error.UPD-502': 'The new version failed its health check.',
    'error.UPD-503': 'Too many plugins failed to load.',
    'error.UPD-601': 'Automatic rollback failed.',
    'error.UPD-701': 'A newer version is required to continue.',
    'error.UPD-702': 'A temporary run cannot update in place.',
  },
  'ja-JP': {
    ...M(
      '{version} に更新しました。',
      '{version} に更新しました。{count} 個のプラグインを無効化しました。',
      '{version} にロールバックしました。',
      '更新に失敗しました：{reason}',
      'コアプラグインが非互換のため、更新を中止しました。',
      '自動ロールバックに失敗し、セーフモードで起動します。',
      '最新です（{version}）。',
      'キャンセルしました。変更はありません。',
      '再試行',
      'ロールバック',
      '修復コマンドをコピー',
    ),
    'error.UPD-101': '更新元に接続できません。',
    'error.UPD-102': '更新元の情報が不正です。',
    'error.UPD-103': 'このチャネルに互換バージョンがありません。',
    'error.UPD-201': '新バージョンに未対応のプラグインがあります。',
    'error.UPD-202': 'コアプラグインが非互換のため更新を中止しました。',
    'error.UPD-301': 'ディスク容量が不足しています。',
    'error.UPD-302': '書き込み権限がありません。',
    'error.UPD-303': '別のインスタンスが更新中です。',
    'error.UPD-401': 'ダウンロードに失敗しました（現在のバージョンは維持）。',
    'error.UPD-402': '整合性チェックに失敗しました。',
    'error.UPD-501': 'インストールに失敗しました。',
    'error.UPD-502': '新バージョンの起動チェックに失敗しました。',
    'error.UPD-503': 'プラグインの読み込み失敗が上限を超えました。',
    'error.UPD-601': '自動ロールバックに失敗しました。',
    'error.UPD-701': '続行には新しいバージョンが必要です。',
    'error.UPD-702': '一時実行のためその場で更新できません。',
  },
  'ko-KR': {
    ...M(
      '{version}(으)로 업데이트했습니다.',
      '{version}(으)로 업데이트했습니다. 플러그인 {count}개를 비활성화했습니다.',
      '{version}(으)로 롤백했습니다.',
      '업데이트 실패: {reason}',
      '핵심 플러그인이 호환되지 않아 업데이트를 차단했습니다.',
      '자동 롤백에 실패하여 안전 모드로 전환했습니다.',
      '최신 상태입니다({version}).',
      '취소했습니다. 변경 사항이 없습니다.',
      '다시 시도',
      '롤백',
      '복구 명령 복사',
    ),
    'error.UPD-101': '업데이트 소스에 연결할 수 없습니다.',
    'error.UPD-102': '업데이트 소스가 잘못된 정보를 반환했습니다.',
    'error.UPD-103': '이 채널에 호환 버전이 없습니다.',
    'error.UPD-201': '새 버전과 호환되지 않는 플러그인이 있습니다.',
    'error.UPD-202': '핵심 플러그인이 호환되지 않아 업데이트를 차단했습니다.',
    'error.UPD-301': '디스크 공간이 부족합니다.',
    'error.UPD-302': '쓰기 권한이 없습니다.',
    'error.UPD-303': '다른 인스턴스가 업데이트 중입니다.',
    'error.UPD-401': '다운로드에 실패했습니다(현재 버전 유지).',
    'error.UPD-402': '무결성 검사에 실패했습니다.',
    'error.UPD-501': '설치에 실패했습니다.',
    'error.UPD-502': '새 버전의 시작 검사에 실패했습니다.',
    'error.UPD-503': '플러그인 로드 실패가 임계값을 초과했습니다.',
    'error.UPD-601': '자동 롤백에 실패했습니다.',
    'error.UPD-701': '계속하려면 더 높은 버전이 필요합니다.',
    'error.UPD-702': '임시 실행이라 제자리 업데이트를 할 수 없습니다.',
  },
  'de-DE': {
    ...M(
      'Aktualisiert auf {version}.',
      'Aktualisiert auf {version}; {count} Plugins deaktiviert.',
      'Zurückgesetzt auf {version}.',
      'Update fehlgeschlagen: {reason}',
      'Ein Kern-Plugin ist inkompatibel; Update blockiert.',
      'Automatisches Zurücksetzen fehlgeschlagen; Sicherheitsmodus aktiv.',
      'Aktuell ({version}).',
      'Abgebrochen; keine Änderungen.',
      'Erneut versuchen',
      'Zurücksetzen',
      'Reparaturbefehl kopieren',
    ),
    'error.UPD-101': 'Update-Quelle nicht erreichbar.',
    'error.UPD-102': 'Update-Quelle lieferte ungültige Daten.',
    'error.UPD-103': 'Keine kompatible Version in diesem Kanal.',
    'error.UPD-201': 'Einige Plugins sind mit der neuen Version inkompatibel.',
    'error.UPD-202': 'Ein Kern-Plugin ist inkompatibel; Update blockiert.',
    'error.UPD-301': 'Nicht genügend Speicherplatz.',
    'error.UPD-302': 'Keine Schreibberechtigung.',
    'error.UPD-303': 'Eine andere Instanz aktualisiert bereits.',
    'error.UPD-401': 'Download fehlgeschlagen; aktuelle Version bleibt.',
    'error.UPD-402': 'Integritätsprüfung fehlgeschlagen.',
    'error.UPD-501': 'Installation fehlgeschlagen.',
    'error.UPD-502': 'Die neue Version hat den Starttest nicht bestanden.',
    'error.UPD-503': 'Zu viele Plugins konnten nicht geladen werden.',
    'error.UPD-601': 'Automatisches Zurücksetzen fehlgeschlagen.',
    'error.UPD-701': 'Eine neuere Version ist erforderlich.',
    'error.UPD-702': 'Temporäre Ausführung kann nicht direkt aktualisiert werden.',
  },
  'fr-FR': {
    ...M(
      'Mis à jour vers {version}.',
      'Mis à jour vers {version} ; {count} plugins désactivés.',
      'Retour à {version} effectué.',
      'Échec de la mise à jour : {reason}',
      'Un plugin principal est incompatible ; mise à jour bloquée.',
      'Échec du retour arrière automatique ; mode sans échec activé.',
      'À jour ({version}).',
      'Annulé ; aucune modification.',
      'Réessayer',
      'Revenir en arrière',
      'Copier la commande de réparation',
    ),
    'error.UPD-101': 'Impossible de joindre la source de mise à jour.',
    'error.UPD-102': 'La source a renvoyé des données invalides.',
    'error.UPD-103': 'Aucune version compatible dans ce canal.',
    'error.UPD-201': 'Certains plugins sont incompatibles avec la nouvelle version.',
    'error.UPD-202': 'Un plugin principal est incompatible ; mise à jour bloquée.',
    'error.UPD-301': 'Espace disque insuffisant.',
    'error.UPD-302': 'Aucun droit d\'écriture.',
    'error.UPD-303': 'Une autre instance effectue déjà la mise à jour.',
    'error.UPD-401': 'Échec du téléchargement ; version actuelle conservée.',
    'error.UPD-402': 'Échec de la vérification d\'intégrité.',
    'error.UPD-501': 'Échec de l\'installation.',
    'error.UPD-502': 'La nouvelle version a échoué au contrôle de démarrage.',
    'error.UPD-503': 'Trop de plugins n\'ont pas pu être chargés.',
    'error.UPD-601': 'Échec du retour arrière automatique.',
    'error.UPD-701': 'Une version plus récente est requise.',
    'error.UPD-702': 'L\'exécution temporaire ne peut pas être mise à jour sur place.',
  },
  'es-ES': {
    ...M(
      'Actualizado a {version}.',
      'Actualizado a {version}; {count} plugins desactivados.',
      'Revertido a {version}.',
      'Error de actualización: {reason}',
      'Un plugin principal no es compatible; actualización bloqueada.',
      'Error en la reversión automática; modo seguro activado.',
      'Actualizado ({version}).',
      'Cancelado; no se realizaron cambios.',
      'Reintentar',
      'Revertir',
      'Copiar comando de reparación',
    ),
    'error.UPD-101': 'No se puede conectar con el origen de actualización.',
    'error.UPD-102': 'El origen devolvió información no válida.',
    'error.UPD-103': 'No hay una versión compatible en este canal.',
    'error.UPD-201': 'Algunos plugins no son compatibles con la nueva versión.',
    'error.UPD-202': 'Un plugin principal no es compatible; actualización bloqueada.',
    'error.UPD-301': 'Espacio en disco insuficiente.',
    'error.UPD-302': 'Sin permiso de escritura.',
    'error.UPD-303': 'Otra instancia ya está actualizando.',
    'error.UPD-401': 'Error de descarga; se mantiene la versión actual.',
    'error.UPD-402': 'Error de verificación de integridad.',
    'error.UPD-501': 'Error de instalación.',
    'error.UPD-502': 'La nueva versión no superó la comprobación de inicio.',
    'error.UPD-503': 'Demasiados plugins no se pudieron cargar.',
    'error.UPD-601': 'Error en la reversión automática.',
    'error.UPD-701': 'Se requiere una versión más reciente.',
    'error.UPD-702': 'La ejecución temporal no se puede actualizar en el lugar.',
  },
  'pt-BR': {
    ...M(
      'Atualizado para {version}.',
      'Atualizado para {version}; {count} plugins desativados.',
      'Revertido para {version}.',
      'Falha na atualização: {reason}',
      'Um plugin principal é incompatível; atualização bloqueada.',
      'Falha na reversão automática; modo de segurança ativado.',
      'Atualizado ({version}).',
      'Cancelado; nenhuma alteração foi feita.',
      'Tentar novamente',
      'Reverter',
      'Copiar comando de reparo',
    ),
    'error.UPD-101': 'Não foi possível conectar à origem de atualização.',
    'error.UPD-102': 'A origem retornou informações inválidas.',
    'error.UPD-103': 'Nenhuma versão compatível neste canal.',
    'error.UPD-201': 'Alguns plugins são incompatíveis com a nova versão.',
    'error.UPD-202': 'Um plugin principal é incompatível; atualização bloqueada.',
    'error.UPD-301': 'Espaço em disco insuficiente.',
    'error.UPD-302': 'Sem permissão de escrita.',
    'error.UPD-303': 'Outra instância já está atualizando.',
    'error.UPD-401': 'Falha no download; versão atual mantida.',
    'error.UPD-402': 'Falha na verificação de integridade.',
    'error.UPD-501': 'Falha na instalação.',
    'error.UPD-502': 'A nova versão falhou na verificação de inicialização.',
    'error.UPD-503': 'Muitos plugins falharam ao carregar.',
    'error.UPD-601': 'Falha na reversão automática.',
    'error.UPD-701': 'É necessária uma versão mais recente.',
    'error.UPD-702': 'Execução temporária não pode ser atualizada no local.',
  },
};

const PLURALS = {
  'zh-CN': {
    'plugin.updated.one': '{count} 个插件已更新',
    'plugin.updated.other': '{count} 个插件已更新',
    'plugin.disabled.one': '{count} 个插件已禁用',
    'plugin.disabled.other': '{count} 个插件已禁用',
  },
  'en-US': {
    'plugin.updated.one': '{count} plugin updated',
    'plugin.updated.other': '{count} plugins updated',
    'plugin.disabled.one': '{count} plugin disabled',
    'plugin.disabled.other': '{count} plugins disabled',
  },
  'ja-JP': {
    'plugin.updated.one': '{count} 個のプラグインを更新しました',
    'plugin.updated.other': '{count} 個のプラグインを更新しました',
    'plugin.disabled.one': '{count} 個のプラグインを無効化しました',
    'plugin.disabled.other': '{count} 個のプラグインを無効化しました',
  },
  'ko-KR': {
    'plugin.updated.one': '플러그인 {count}개 업데이트됨',
    'plugin.updated.other': '플러그인 {count}개 업데이트됨',
    'plugin.disabled.one': '플러그인 {count}개 비활성화됨',
    'plugin.disabled.other': '플러그인 {count}개 비활성화됨',
  },
  'de-DE': {
    'plugin.updated.one': '{count} Plugin aktualisiert',
    'plugin.updated.other': '{count} Plugins aktualisiert',
    'plugin.disabled.one': '{count} Plugin deaktiviert',
    'plugin.disabled.other': '{count} Plugins deaktiviert',
  },
  'fr-FR': {
    'plugin.updated.one': '{count} plugin mis à jour',
    'plugin.updated.other': '{count} plugins mis à jour',
    'plugin.disabled.one': '{count} plugin désactivé',
    'plugin.disabled.other': '{count} plugins désactivés',
  },
  'es-ES': {
    'plugin.updated.one': '{count} plugin actualizado',
    'plugin.updated.other': '{count} plugins actualizados',
    'plugin.disabled.one': '{count} plugin desactivado',
    'plugin.disabled.other': '{count} plugins desactivados',
  },
  'pt-BR': {
    'plugin.updated.one': '{count} plugin atualizado',
    'plugin.updated.other': '{count} plugins atualizados',
    'plugin.disabled.one': '{count} plugin desativado',
    'plugin.disabled.other': '{count} plugins desativados',
  },
};

for (const [locale, entries] of Object.entries(PLURALS)) {
  if (CATALOGS[locale]) Object.assign(CATALOGS[locale], entries);
}

/**
 * @param {string} locale
 * @returns {string} 匹配到的受支持语言
 */
export function normalizeLocale(locale) {
  if (typeof locale !== 'string' || locale.trim() === '') return 'zh-CN';
  const raw = locale.trim();
  if (CATALOGS[raw]) return raw;
  const lower = raw.toLowerCase();
  const exact = SUPPORTED_LOCALES.find((item) => item.toLowerCase() === lower);
  if (exact) return exact;
  const language = lower.split('-')[0];
  const byLanguage = SUPPORTED_LOCALES.find((item) => item.toLowerCase().split('-')[0] === language);
  return byLanguage || FALLBACK_LOCALE;
}

export class I18n {
  /** @param {string} [locale] */
  constructor(locale = 'zh-CN') {
    this.locale = normalizeLocale(locale);
  }

  /**
   * @param {string} key
   * @param {Record<string, string|number>} [params]
   * @returns {string}
   */
  t(key, params = {}) {
    const primary = CATALOGS[this.locale];
    const fallback = CATALOGS[FALLBACK_LOCALE];
    let template = primary && primary[key];
    if (typeof template !== 'string') template = fallback[key];
    if (typeof template !== 'string') return key;
    return template.replace(/\{(\w+)\}/g, (match, name) => {
      if (!(name in params)) return match;
      return String(params[name]);
    });
  }

  /** @param {string} code @param {Record<string, string|number>} [params] */
  error(code, params = {}) {
    return this.t(`error.${code}`, params);
  }

  /** @param {string} key @param {number} count @param {Record<string, string|number>} [params] */
  plural(key, count, params = {}) {
    let category = 'other';
    try {
      category = new Intl.PluralRules(this.locale).select(count);
    } catch {
      category = count === 1 ? 'one' : 'other';
    }
    const localized = this.t(`${key}.${category}`, { ...params, count });
    if (localized !== `${key}.${category}`) return localized;
    return this.t(`${key}.other`, { ...params, count });
  }
}
