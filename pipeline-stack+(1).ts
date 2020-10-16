import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as sns from '@aws-cdk/aws-sns';
import * as s3 from '@aws-cdk/aws-s3';
import * as iam from '@aws-cdk/aws-iam';
import * as ssm from '@aws-cdk/aws-ssm';
import * as codebuild from '@aws-cdk/aws-codebuild';
import * as codepipeline from '@aws-cdk/aws-codepipeline';
import * as cpaction from '@aws-cdk/aws-codepipeline-actions';
import * as codestarnotification from '@aws-cdk/aws-codestarnotifications';
import * as secretsmanager from '@aws-cdk/aws-secretsmanager';

import { CodebuildOptions } from './types';

export class PipelineStack extends cdk.Stack {
  constructor(
    scope: cdk.Construct,
    id: string,
    environment: CodebuildOptions,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    const dockerArn = ssm.StringParameter.fromStringParameterName(
      this,
      `Bridge-Codebuild-Arn`,
      `/bridge/codebuild/DOCKER_HUB_ARN`,
    );

    const goldenImage = codebuild.LinuxBuildImage.fromDockerRegistry(
      'sygna/codebuild_base_image:latest',
      {
        secretsManagerCredentials: secretsmanager.Secret.fromSecretArn(
          this,
          'BridgeCodebuildDockerArn',
          dockerArn.stringValue,
        ),
      },
    );

    // create new s3 bucket to hosting our sit testing report
    const reportBucket = new s3.Bucket(this, `Bridge-Api-Sit-Report-${environment.ENV}-v2`, {
      bucketName: `bridge-api-sit-report-${environment.ENV.toLowerCase()}-v2`,
      websiteIndexDocument: 'index.html',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        blockPublicPolicy: false,
        ignorePublicAcls: true,
        restrictPublicBuckets: false,
      }),
      accessControl: s3.BucketAccessControl.PUBLIC_READ,
    });

    reportBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        resources: [`${reportBucket.bucketArn}/*.html`],
        actions: ['s3:GetObject'],
        principals: [new iam.ArnPrincipal('*')],
      }),
    );

    // Codebuild bucket
    const codebuildBucket = new s3.Bucket(
      this,
      `Bridge-Api-Codebuild-Bucket-${environment.ENV}-v2`,
      {
        bucketName: `bridge-api-codebuild-bucket-${environment.ENV.toLowerCase()}-v2`,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        blockPublicAccess: new s3.BlockPublicAccess({
          blockPublicAcls: true,
          blockPublicPolicy: false,
          ignorePublicAcls: true,
          restrictPublicBuckets: false,
        }),
        accessControl: s3.BucketAccessControl.PUBLIC_READ,
      },
    );

    // TODO: restrict permissions
    const buildRole = new iam.Role(this, `Bridge-Api-CodeBuild-Role-${environment.ENV}-v2`, {
      roleName: `bridge-api-codebuild-role-${environment.ENV.toLowerCase()}`,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      managedPolicies: [
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AWSCodeBuildAdminAccess' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonS3FullAccess' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AWSLambdaFullAccess' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonAPIGatewayAdministrator' },
      ],
    });

    new iam.Policy(this, `Bridge-Api-Codebuild-Policy-${environment.ENV}-v2`, {
      policyName: `BridgeApiCodebuildActions`,
      roles: [buildRole],
      statements: [
        new iam.PolicyStatement({
          resources: ['*'],
          actions: [
            'cloudformation:*',
            'ec2:*',
            'sts:*',
            'ecr:*',
            'ecs:*',
            'ssm:*',
            'secretsmanager:GetSecretValue',
            'iam:*',
            'kms:*',
            'log:*',
            'wafv2:*',
          ],
        }),
        new iam.PolicyStatement({
          resources: [reportBucket.bucketArn],
          actions: ['s3:*'],
        }),
      ],
    });

    const vpc = ec2.Vpc.fromVpcAttributes(this, `Bridge-Vpc-${environment.testStage}-v2`, {
      vpcId: environment.vpcId,
      availabilityZones: [
        cdk.Fn.select(0, environment.availabilityZones),
        cdk.Fn.select(1, environment.availabilityZones),
      ],
      publicSubnetIds: [
        cdk.Fn.select(0, environment.publicSubnetIds),
        cdk.Fn.select(1, environment.publicSubnetIds),
      ],
      privateSubnetIds: [
        cdk.Fn.select(0, environment.privateSubnetIds),
        cdk.Fn.select(1, environment.privateSubnetIds),
      ],
      privateSubnetRouteTableIds: [
        cdk.Fn.select(0, environment.privateSubnetRouteTableIds),
        cdk.Fn.select(1, environment.privateSubnetRouteTableIds),
      ],
      publicSubnetRouteTableIds: [
        cdk.Fn.select(0, environment.publicSubnetRouteTableIds),
        cdk.Fn.select(1, environment.publicSubnetRouteTableIds),
      ],
    });

    const codePipeline = new codepipeline.Pipeline(
      this,
      `Bridge-Api-Pipeline-${environment.ENV}-v2`,
      {
        pipelineName: `bridge-api-pipeline-${environment.ENV}-v2`,
        restartExecutionOnUpdate: true,
        artifactBucket: codebuildBucket,
      },
    );

    // Source stage, grab code from Github
    const sourceStage = codePipeline.addStage({
      stageName: 'Source',
    });

    const buildStage = codePipeline.addStage({
      stageName: 'Build',
      placement: {
        justAfter: sourceStage,
      },
    });

    let approveStage: codepipeline.IStage | undefined;
    if (environment.ENV !== 'dev') {
      // Approve stage
      approveStage = codePipeline.addStage({
        stageName: 'Approval',
        placement: {
          justAfter: buildStage,
        },
      });
    }

    // Deploy stage
    const deployStage = codePipeline.addStage({
      stageName: 'Deploy',
      placement: {
        justAfter: approveStage || buildStage,
      },
    });

    const oauthSecret = cdk.SecretValue.secretsManager('bridge-githubAccessToken');
    const slackHookUrl = ssm.StringParameter.fromStringParameterName(
      this,
      `bridge-api-slack-${environment.ENV}-url`,
      `/sit/${environment.ENV}/SLACK_HOOK_URL`,
    );

    const sourceOutput = new codepipeline.Artifact('sourceOutput');
    const sourceAction = new cpaction.GitHubSourceAction({
      actionName: `bridge-api-codebuild-action-${environment.ENV}-v2`,
      owner: 'CoolBitX-Technology',
      repo: 'sygna-bridge-api',
      oauthToken: oauthSecret,
      branch: `${environment.branch}`,
      trigger: cpaction.GitHubTrigger.WEBHOOK,
      output: sourceOutput,
    });

    sourceStage.addAction(sourceAction);

    const codeBuildProject = new codebuild.PipelineProject(
      this,
      `Bridge-Api-${environment.ENV}-v2`,
      {
        projectName: `Bridge-Api-Codebuild-${environment.ENV}-v2`,
        description: `Bridge-Api Codebuild - ${environment.ENV}`,
        role: buildRole,
        vpc,
        subnetSelection: vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE,
        }),
        environmentVariables: {
          ENV: {
            value: environment.ENV,
          },
          GITHUB_OAUTH_TOKEN: {
            // type: BuildEnvironmentVariableType.SECRETS_MANAGER,
            value: oauthSecret.toString(),
          },
          TEST_STAGE: {
            value: environment.testStage,
          },
          PROD_STAGE: {
            value: environment.productionStage,
          },
          BRANCH: {
            value: environment.branch,
          },
          S3_REPORT_BUCKET_URL: {
            value: reportBucket.bucketWebsiteUrl,
          },
          SLACK_HOOK_URL: {
            // type: BuildEnvironmentVariableType.PARAMETER_STORE,
            value: slackHookUrl.stringValue,
          },
        },
        environment: {
          buildImage: goldenImage,
          privileged: true,
        },
        buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      },
    );

    // allow lambda call sit
    codeBuildProject.connections.allowFromAnyIpv4(ec2.Port.tcpRange(3000, 3000), 'allow to sit');

    const buildOutput = new codepipeline.Artifact('buildOutput');
    const buildAction = new cpaction.CodeBuildAction({
      actionName: 'Build',
      input: sourceOutput,
      outputs: [buildOutput],
      project: codeBuildProject,
    });

    buildStage.addAction(buildAction);

    if (environment.ENV !== 'dev') {
      const snsArn = ssm.StringParameter.fromStringParameterName(
        this,
        `bridge-arn-slackSNS`,
        '/bridge/arn/slack-sns',
      ).stringValue;
      // Approve stage
      const sygnaBridgeApprovalSNS = sns.Topic.fromTopicArn(
        this,
        `Bridge-ApprovalSNS-${environment.ENV}-v2`,
        snsArn,
      );
      const approvalAction = new cpaction.ManualApprovalAction({
        actionName: 'ApprovalOrDeny',
        notificationTopic: sygnaBridgeApprovalSNS,
        externalEntityLink: `https://github.com/CoolBitX-Technology/${sourceAction.variables.repositoryName}/commit/${sourceAction.variables.commitId}`,
        additionalInformation: 'Please check Github commit before APPROVE!!',
      });

      approveStage?.addAction(approvalAction);
    }

    const codeBuildDeploy = new codebuild.PipelineProject(
      this,
      `Bridge-Api-Codebuild-Deploy-${environment.ENV}-v2`,
      {
        projectName: `Bridge-Api-Codebuild-Deploy-${environment.ENV}-v2`,
        description: `Bridge Api Codebuild Deploy - ${environment.ENV}`,
        role: buildRole,
        environment: {
          buildImage: goldenImage,
          privileged: true,
        },
        buildSpec: codebuild.BuildSpec.fromSourceFilename('buildDeploy.yml'),
        environmentVariables: {
          ENV: {
            value: environment.ENV,
          },
          GITHUB_OAUTH_TOKEN: {
            // type: BuildEnvironmentVariableType.SECRETS_MANAGER,
            value: oauthSecret.toString(),
          },
          TEST_STAGE: {
            value: environment.testStage,
          },
          PROD_STAGE: {
            value: environment.productionStage,
          },
          BRANCH: {
            value: environment.branch,
          },
          S3_REPORT_BUCKET_URL: {
            value: reportBucket.bucketWebsiteUrl,
          },
          SLACK_HOOK_URL: {
            // type: BuildEnvironmentVariableType.PARAMETER_STORE,
            value: slackHookUrl.stringValue,
          },
        },
      },
    );
    // Deploy stage
    const deployAction = new cpaction.CodeBuildAction({
      actionName: 'Deploy',
      input: buildOutput,
      project: codeBuildDeploy,
    });
    deployStage.addAction(deployAction);

    const snsJiraArn = ssm.StringParameter.valueForStringParameter(
      this,
      '/cfstack/arn/JIRA_INTEGRATION',
    );
    const codepipelinebuildStar = new codestarnotification.CfnNotificationRule(
      this,
      'bridge-api-codestar-notification',
      {
        detailType: 'FULL',
        eventTypeIds: [
          'codepipeline-pipeline-pipeline-execution-succeeded',
          'codepipeline-pipeline-pipeline-execution-failed',
        ],
        name: `bridge-api-${environment.ENV}-codepipeline-notification`,
        resource: codePipeline.pipelineArn,
        targets: [
          {
            targetType: 'SNS',
            targetAddress: snsJiraArn,
          },
        ],
      },
    );
  }
}
