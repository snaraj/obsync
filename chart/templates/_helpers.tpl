{{- define "obsync.name" -}}
obsync
{{- end -}}

{{/*
app.kubernetes.io/version is the standard recommended label and is what makes
`kubectl get po -L app.kubernetes.io/version` answer "which release is running"
without anyone resolving a digest by hand. It is DERIVED from .Chart.AppVersion
rather than read from values, so no override can make the label disagree with
the chart that rendered it. It is a label and never a selector key: the
Deployment, Service, and NetworkPolicy selectors each state their keys
literally, which is what keeps this addable to a live Deployment at all
(selectors are immutable).
*/}}
{{- define "obsync.labels" -}}
app.kubernetes.io/name: {{ include "obsync.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "obsync.selectorLabels" -}}
app.kubernetes.io/name: {{ include "obsync.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
obsync.mirrorPaths renders the comma-separated OBSYNC_BLOBS_MIRRORS value from
the SAME list the volumes and mounts are built from, so the process and the
mounts cannot disagree about where a mirror is. One value, three renders.
*/}}
{{- define "obsync.mirrorPaths" -}}
{{- $paths := list -}}
{{- range .Values.storage.mirrors -}}
{{- $paths = append $paths (printf "/data/mirrors/%s" .name) -}}
{{- end -}}
{{- join "," $paths -}}
{{- end -}}
