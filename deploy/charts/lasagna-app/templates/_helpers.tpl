{{/*
Expand the name of the chart.
*/}}
{{- define "lasagna-app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "lasagna-app.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "lasagna-app.labels" -}}
app.kubernetes.io/name: {{ include "lasagna-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "lasagna-app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lasagna-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Resolve the secret name to mount as envFrom — either an existing one
provided via `app.existingSecret`, or the one this chart creates.
*/}}
{{- define "lasagna-app.secretName" -}}
{{- if .Values.app.existingSecret -}}
{{- .Values.app.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "lasagna-app.fullname" .) -}}
{{- end -}}
{{- end -}}
