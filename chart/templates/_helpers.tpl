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
obsync.annotationDomain is the prefix of the two platform annotations, or
nothing. They are a GitOps platform's signals, not the chart's: a
deployment-ready flag on the Deployment and the provisioned capacity on each
claim (docs/platform-onboarding.md). Empty, the shipped default, renders
neither, so no deployer's render carries another deployer's domain. A set value
becomes the prefix of an annotation KEY, so it must be what the API server
accepts there -- a lower-case RFC 1123 DNS subdomain of at most 253 characters
-- and never a prefix Kubernetes reserves for its own components. Anything else
fails the render and names the value, rather than rendering a key the cluster
refuses at apply time or one that claims to be Kubernetes'.
*/}}
{{- define "obsync.annotationDomain" -}}
{{- $domain := .Values.platform.annotationDomain -}}
{{- if $domain -}}
{{- if or (gt (len $domain) 253) (not (regexMatch `^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$` $domain)) -}}
{{- fail (printf "platform.annotationDomain %q is not a DNS subdomain: lower-case letters, digits, '-' and '.', every label starting and ending with a letter or digit, 253 characters at most" $domain) -}}
{{- end -}}
{{- if or (eq $domain "kubernetes.io" "k8s.io") (hasSuffix ".kubernetes.io" $domain) (hasSuffix ".k8s.io" $domain) -}}
{{- fail (printf "platform.annotationDomain %q is a prefix Kubernetes reserves for its own components; name your platform's domain" $domain) -}}
{{- end -}}
{{- $domain -}}
{{- end -}}
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
